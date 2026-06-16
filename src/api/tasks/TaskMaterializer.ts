import type { ChatKitStore, StoreContext } from '../chatkit/store';
import type {
  ThreadItem,
  ThreadMetadata,
  ThreadRef,
  AssistantMessageItem,
  UserMessageItem,
} from '../chatkit/types';
import {
  generateId,
  nowTimestamp,
  toThreadRef,
} from '../chatkit/types';
import { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import type { RunExecutionBackend } from '../runs/RunExecutionBackend';
import { RunStatus, XpodRunStepType as RunStepType } from '../runs/schema';
import {
  extractResourceLocalId,
  generateRunResourceId,
  generateRunStepResourceId,
  resolveDataResource,
  resolveRunUrn,
  type RunRecordData,
  type RunStepRecordData,
  type RunStore,
} from '../runs/store';
import type { AgentRuntimeConfig, RunnerProtocol, RunnerType } from '../runs/AgentRuntimeTypes';
import { isWorkspaceRef } from '../workspace/types';
import { TaskStatus, TaskTriggerKind } from './schema';
import { resolveTaskResource as expandTaskResource, resolveTaskUrn, type TaskRecordData } from './store';

export interface MaterializedTaskRun {
  task: TaskRecordData;
  run: RunRecordData;
  assistant?: ThreadItem;
}

export interface TaskMaterializerOptions<TContext = StoreContext> {
  store: ChatKitStore<TContext> & RunStore<TContext>;
  executionBackend?: RunExecutionBackend;
  executeRuns?: boolean;
}

export class TaskMaterializer<TContext = StoreContext> {
  private readonly store: ChatKitStore<TContext> & RunStore<TContext>;
  private readonly executionBackend: RunExecutionBackend;
  private readonly executeRuns: boolean;

  public constructor(options: TaskMaterializerOptions<TContext>) {
    this.store = options.store;
    this.executionBackend = options.executionBackend ?? new InngestRunExecutionBackend();
    this.executeRuns = options.executeRuns ?? true;
  }

  public async materialize(input: {
    task: TaskRecordData;
    context: TContext;
    trigger: {
      kind: 'once' | 'interval' | 'cron' | 'event' | 'manual';
      scheduledFor?: number;
      eventName?: string;
      payload?: Record<string, unknown>;
    };
  }): Promise<MaterializedTaskRun> {
    const { task, context, trigger } = input;
    if (task.status !== TaskStatus.ACTIVE) {
      throw new Error(`Task ${task.id} is not active`);
    }

    const threadRef = this.threadRefFromTask(task);
    const thread = await this.ensureThread(task, context);
    const prompt = this.buildPrompt(task, trigger);
    const userMessage = await this.createUserMessage(threadRef, task, context, prompt);
    await this.store.addThreadItem(threadRef, userMessage, context);

    const run = await this.createRun(task, prompt, userMessage, context, trigger);
    task.lastRunAt = trigger.scheduledFor ?? nowTimestamp();
    task.updatedAt = nowTimestamp();

    if (task.triggerKind === TaskTriggerKind.ONCE) {
      task.nextRunAt = undefined;
    } else if (task.triggerKind === TaskTriggerKind.INTERVAL) {
      task.nextRunAt = this.computeNextIntervalRunAt(task, task.lastRunAt);
    } else if (task.triggerKind === TaskTriggerKind.CRON) {
      task.nextRunAt = this.computeNextCronRunAt(task, task.lastRunAt);
    }

    if (this.hasSaveTask(this.store)) {
      await this.store.saveTask(task, context);
    }

    if (this.executeRuns) {
      const assistant = await this.executeRun({ task, thread, run, userMessage, context });
      if (task.triggerKind === TaskTriggerKind.ONCE) {
        task.status = run.status === RunStatus.COMPLETED ? TaskStatus.COMPLETED : TaskStatus.FAILED;
        task.updatedAt = nowTimestamp();
        if (this.hasSaveTask(this.store)) {
          await this.store.saveTask(task, context);
        }
      }
      return { task, run, assistant };
    }

    if (task.triggerKind === TaskTriggerKind.ONCE) {
      task.status = TaskStatus.COMPLETED;
      task.updatedAt = nowTimestamp();
      if (this.hasSaveTask(this.store)) {
        await this.store.saveTask(task, context);
      }
    }

    return { task, run };
  }

  private async executeRun(input: {
    task: TaskRecordData;
    thread: ThreadMetadata;
    run: RunRecordData;
    userMessage: UserMessageItem;
    context: TContext;
  }): Promise<ThreadItem | undefined> {
    const { task, thread, run, userMessage, context } = input;
    const runtimeConfig = this.buildRuntimeConfig(task);
    const threadRef = this.threadRefFromTask(task);
    const assistantItem = await this.createAssistantMessage(thread, context);
    await this.store.addThreadItem(threadRef, assistantItem, context);
    await this.markRunStarted(run, context);

    let fullText = '';
    let runtimeError: string | undefined;

    for await (
      const event of this.executionBackend.start({
        runId: run.id,
        threadId: thread.id,
        prompt: run.prompt ?? task.prompt,
        conversation: await this.loadConversation(threadRef, userMessage.id, context),
        config: runtimeConfig,
        authBindingId: task.authBinding?.id,
        context: context as StoreContext,
      })
    ) {
      if (event.type === 'text') {
        fullText += event.text;
        await this.appendRunStep(run, RunStepType.TEXT_DELTA, context, {
          message: event.text,
          data: { delta: event.text },
        });
        continue;
      }

      if (event.type === 'auth_required') {
        await this.appendRunStep(run, RunStepType.AUTH_REQUIRED, context, {
          message: event.message,
          data: {
            method: event.method,
            url: event.url,
            options: event.options,
          },
        });
        continue;
      }

      if (event.type === 'tool_call') {
        await this.appendRunStep(run, RunStepType.TOOL_CALL, context, {
          message: event.name,
          data: {
            requestId: event.requestId,
            name: event.name,
            arguments: event.arguments,
          },
        });
        await this.finishRun(run, RunStatus.WAITING_INPUT, context, `Tool call ${event.name} requires steering`);
        assistantItem.status = 'incomplete';
        assistantItem.content = [{ type: 'output_text', text: fullText }];
        await this.store.saveItem(threadRef, assistantItem, context);
        return assistantItem;
      }

      if (event.type === 'waiting_runner') {
        runtimeError = event.message;
        await this.appendRunStep(run, RunStepType.WAITING_RUNNER, context, {
          message: event.message,
          data: { workspace: event.workspace },
        });
        await this.finishRun(run, RunStatus.WAITING_RUNNER, context, event.message);
        assistantItem.status = 'incomplete';
        assistantItem.content = [{ type: 'output_text', text: fullText }];
        await this.store.saveItem(threadRef, assistantItem, context);
        return assistantItem;
      }

      runtimeError = event.message;
      await this.appendRunStep(run, RunStepType.ERROR, context, {
        message: event.message,
      });
      break;
    }

    assistantItem.status = runtimeError ? 'incomplete' : 'completed';
    assistantItem.content = [{ type: 'output_text', text: fullText }];
    await this.store.saveItem(threadRef, assistantItem, context);
    await this.finishRun(
      run,
      runtimeError ? RunStatus.FAILED : RunStatus.COMPLETED,
      context,
      runtimeError,
    );
    return assistantItem;
  }

  private async ensureThread(task: TaskRecordData, context: TContext): Promise<ThreadMetadata> {
    const threadRef = this.threadRefFromTask(task);
    try {
      return await this.store.loadThread(threadRef, context);
    } catch {
      const now = nowTimestamp();
      const taskParentKey = this.resolveTaskThreadParentKey(task);
      const metadata: ThreadMetadata = {
        id: this.extractThreadId(task.thread),
        parent: `task/index.ttl#${taskParentKey}`,
        title: task.title,
        status: { type: 'active' },
        workspace: task.workspace,
        created_at: now,
        updated_at: now,
        metadata: {
          task: this.resolveTaskResource(task, context),
          runtime: {
            workspace: task.workspace,
            runner: this.parseRunner(task.runner),
          },
        },
      };
      await this.store.saveThread(metadata, context);
      return metadata;
    }
  }

  private async createRun(
    task: TaskRecordData,
    prompt: string,
    userMessage: UserMessageItem,
    context: TContext,
    trigger: {
      kind: string;
      scheduledFor?: number;
      eventName?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<RunRecordData> {
    const now = nowTimestamp();
    const taskParentKey = this.resolveTaskThreadParentKey(task);
    const run: RunRecordData = {
      id: generateRunResourceId({
        key: generateId('run'),
        parentKind: 'task',
        parentKey: taskParentKey,
        createdAt: now,
      }),
      task: this.resolveTaskResource(task, context),
      thread: task.thread,
      workspace: task.workspace,
      status: RunStatus.QUEUED,
      runner: task.runner,
      prompt,
      metadata: {
        taskId: task.id,
        threadId: this.extractThreadId(task.thread),
        userMessageId: userMessage.id,
        runtimeConfig: this.buildRuntimeConfig(task),
        authBinding: task.authBinding,
        authBindingId: task.authBinding?.id,
        trigger,
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveRun(run, context);
    await this.appendRunStep(run, RunStepType.CREATED, context, {
      message: 'Task run created',
      data: {
        task: run.task,
        thread: run.thread,
        workspace: run.workspace,
        runner: run.runner,
        trigger,
        authBinding: task.authBinding,
      },
    });
    return run;
  }

  private async markRunStarted(run: RunRecordData, context: TContext): Promise<void> {
    const now = nowTimestamp();
    run.status = RunStatus.RUNNING;
    run.startedAt = now;
    run.updatedAt = now;
    await this.store.saveRun(run, context);
    await this.appendRunStep(run, RunStepType.STARTED, context, {
      message: 'Task run started',
    });
  }

  private async finishRun(
    run: RunRecordData,
    status: RunRecordData['status'],
    context: TContext,
    error?: string,
  ): Promise<void> {
    const now = nowTimestamp();
    run.status = status;
    run.completedAt = this.isWaitingStatus(status) ? undefined : now;
    run.updatedAt = now;
    run.error = error;
    await this.store.saveRun(run, context);
    await this.appendRunStep(
      run,
      this.stepTypeForStatus(status),
      context,
      {
        message: error ?? `Run ${status}`,
        data: { status },
      },
    );
  }

  private isWaitingStatus(status: RunRecordData['status']): boolean {
    return status === RunStatus.WAITING_INPUT || status === RunStatus.WAITING_RUNNER;
  }

  private stepTypeForStatus(status: RunRecordData['status']): RunStepRecordData['type'] {
    if (status === RunStatus.COMPLETED) {
      return RunStepType.COMPLETED;
    }
    if (status === RunStatus.CANCELLED) {
      return RunStepType.CANCELLED;
    }
    if (status === RunStatus.WAITING_INPUT) {
      return RunStepType.WAITING_INPUT;
    }
    if (status === RunStatus.WAITING_RUNNER) {
      return RunStepType.WAITING_RUNNER;
    }
    return RunStepType.FAILED;
  }

  private async appendRunStep(
    run: RunRecordData,
    type: RunStepRecordData['type'],
    context: TContext,
    options: {
      message?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const createdAt = nowTimestamp();
    await this.store.appendRunStep({
      id: generateRunStepResourceId({
        key: generateId('run-step'),
        runId: run.id,
        createdAt,
      }),
      runId: run.id,
      run: this.resolveRunResource(run, context),
      type,
      message: options.message,
      data: options.data,
      createdAt,
    }, context);
  }

  private async createUserMessage(
    threadRef: ThreadRef,
    task: TaskRecordData,
    context: TContext,
    prompt: string,
  ): Promise<UserMessageItem> {
    const thread = await this.store.loadThread(threadRef, context);
    return {
      id: this.store.generateItemId('user_message', thread, context),
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: prompt }],
      created_at: nowTimestamp(),
    };
  }

  private buildPrompt(
    task: TaskRecordData,
    trigger: {
      kind: string;
      scheduledFor?: number;
      eventName?: string;
      payload?: Record<string, unknown>;
    },
  ): string {
    if (trigger.kind !== 'event' || !trigger.payload) {
      return task.prompt;
    }
    return `${task.prompt}\n\nEvent payload:\n${JSON.stringify(trigger.payload)}`;
  }

  private async createAssistantMessage(
    thread: ThreadMetadata,
    context: TContext,
  ): Promise<AssistantMessageItem> {
    return {
      id: this.store.generateItemId('assistant_message', thread, context),
      thread_id: thread.id,
      type: 'assistant_message',
      content: [{ type: 'output_text', text: '' }],
      status: 'in_progress',
      created_at: nowTimestamp(),
    };
  }

  private async loadConversation(
    threadRef: ThreadRef,
    currentUserMessageId: string,
    context: TContext,
  ): Promise<Array<{ role: 'user' | 'assistant'; text: string; createdAt: number }>> {
    const items = await this.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    const conversation: Array<{ role: 'user' | 'assistant'; text: string; createdAt: number }> = [];

    for (const item of items.data) {
      if (item.id === currentUserMessageId) {
        break;
      }
      if (item.type === 'user_message') {
        const text = item.content
          .filter((content) => content.type === 'input_text')
          .map((content) => content.text)
          .join('\n')
          .trim();
        if (text) {
          conversation.push({ role: 'user', text, createdAt: item.created_at });
        }
        continue;
      }
      if (item.type === 'assistant_message' && item.status !== 'in_progress') {
        const text = item.content
          .filter((content) => content.type === 'output_text')
          .map((content) => content.text)
          .join('\n')
          .trim();
        if (text) {
          conversation.push({ role: 'assistant', text, createdAt: item.created_at });
        }
      }
    }

    return conversation;
  }

  private buildRuntimeConfig(task: TaskRecordData): AgentRuntimeConfig {
    if (!isWorkspaceRef(task.workspace)) {
      throw new Error('Task workspace reference is required');
    }
    return {
      workspace: task.workspace,
      runner: this.parseRunner(task.runner),
    };
  }

  private parseRunner(runner: string): { protocol: RunnerProtocol; type: RunnerType } {
    const [protocol, type] = runner.split(':');
    return {
      protocol: protocol === 'acp' ? 'acp' : 'pi',
      type: this.isRunnerType(type) ? type : 'pi',
    };
  }

  private isRunnerType(value: unknown): value is RunnerType {
    return value === 'pi' || value === 'codex' || value === 'claude' || value === 'codebuddy';
  }

  private computeNextIntervalRunAt(task: TaskRecordData, from: number): number | undefined {
    if (!task.intervalSeconds || task.intervalSeconds <= 0) {
      return undefined;
    }
    return from + task.intervalSeconds;
  }

  private computeNextCronRunAt(task: TaskRecordData, from: number): number {
    const firstField = task.cron?.trim().split(/\s+/)[0];
    const everyMinuteMatch = firstField?.match(/^\*\/(\d+)$/);
    if (everyMinuteMatch) {
      return from + Math.max(1, Number(everyMinuteMatch[1])) * 60;
    }
    return from + 60;
  }

  private threadRefFromTask(task: TaskRecordData): ThreadRef {
    const parsed = this.parseThreadResource(task.thread);
    if (parsed) {
      return parsed;
    }
    return toThreadRef({
      thread_id: this.extractThreadId(task.thread),
    });
  }

  private resolveTaskThreadParentKey(task: TaskRecordData): string {
    const threadId = this.extractThreadId(task.thread);
    const match = threadId.match(/^task\/([^/]+)\//);
    return match ? decodeURIComponent(match[1]) : extractResourceLocalId(task.id);
  }

  private parseThreadResource(thread: string): ThreadRef | undefined {
    if (!/^https?:\/\//.test(thread)) {
      return undefined;
    }
    try {
      const url = new URL(thread);
      const match = url.pathname.match(/\/\.data\/(?:chat|task)\/([^/]+)\/index\.ttl$/);
      return match
        ? { thread_id: thread as `http://${string}` | `https://${string}` }
        : { thread_id: thread as `http://${string}` | `https://${string}` };
    } catch {
      return undefined;
    }
  }

  private extractThreadId(thread: string): string {
    const dataMarker = '/.data/';
    if (/^https?:\/\//.test(thread)) {
      try {
        const url = new URL(thread);
        const markerIndex = url.pathname.indexOf(dataMarker);
        if (markerIndex >= 0 && url.hash) {
          return `${url.pathname.slice(markerIndex + dataMarker.length)}${url.hash}`;
        }
        return url.hash.startsWith('#') ? decodeURIComponent(url.hash.slice(1)) : thread;
      } catch {
        return thread;
      }
    }
    if (thread.includes(dataMarker)) {
      return thread.slice(thread.indexOf(dataMarker) + dataMarker.length);
    }
    const urnMarker = 'urn:xpod:thread:';
    if (thread.startsWith(urnMarker)) {
      const parts = thread.slice(urnMarker.length).split(':');
      return parts.length > 1 ? decodeURIComponent(parts[1]) : decodeURIComponent(parts[0]);
    }
    return thread;
  }

  private resolveTaskResource(task: TaskRecordData, context: TContext): string {
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl) {
      return expandTaskResource(podBaseUrl, task.id);
    }
    return resolveTaskUrn(task.id);
  }

  private resolveRunResource(run: RunRecordData, context: TContext): string {
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl) {
      return resolveDataResource(podBaseUrl, run.id);
    }
    return resolveRunUrn(run.id);
  }

  private resolvePodBaseUrl(context: TContext): string | undefined {
    const auth = (context as Record<string, unknown>).auth as { webId?: unknown } | undefined;
    const webId = typeof auth?.webId === 'string' ? auth.webId : undefined;
    if (!webId) {
      return undefined;
    }
    try {
      const url = new URL(webId);
      url.hash = '';
      url.search = '';
      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (!normalizedPath.endsWith('/profile/card')) {
        return undefined;
      }
      const podPath = normalizedPath.slice(0, -'/profile/card'.length) || '/';
      url.pathname = podPath;
      return url.toString().replace(/\/$/, '');
    } catch {
      return undefined;
    }
  }

  private hasSaveTask(value: unknown): value is { saveTask(task: TaskRecordData, context: TContext): Promise<void> } {
    return typeof (value as { saveTask?: unknown }).saveTask === 'function';
  }
}
