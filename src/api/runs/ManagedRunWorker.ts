import type { ChatKitStore, StoreContext } from '../chatkit/store';
import type {
  AssistantMessageItem,
  ThreadItem,
  ThreadMetadata,
  ThreadRef,
  UserMessageItem,
} from '../chatkit/types';
import {
  extractAssistantMessageText,
  extractUserMessageText,
  generateId,
  nowTimestamp,
  toThreadRef,
} from '../chatkit/types';
import type { AgentRuntimeConfig, AgentRuntimeEvent, RunnerProtocol, RunnerType } from './AgentRuntimeTypes';
import type { RunExecutionBackend, RunExecutionInput } from './RunExecutionBackend';
import { RunStatus, XpodRunStepType as RunStepType } from './schema';
import {
  canClaimRun,
  generateRunStepResourceId,
  resolveDataResource,
  resolveRunUrn,
  type RunRecordData,
  type RunStepRecordData,
  type RunStore,
} from './store';
import { isWorkspaceRef } from '../workspace/types';

export type ManagedRunStore<TContext = StoreContext> = ChatKitStore<TContext> & RunStore<TContext>;

export interface ManagedRunWorkerOptions<TContext = StoreContext> {
  store: ManagedRunStore<TContext>;
  runtimeDriver: RunExecutionBackend;
  leaseOwner?: string;
  leaseDurationSeconds?: number;
}

export interface ManagedRunExecutionResult {
  runId: string;
  status: RunRecordData['status'] | 'skipped';
}

const RUN_WAITING_STATUSES = new Set<string>([
  RunStatus.WAITING_INPUT,
  RunStatus.WAITING_RUNNER,
]);

type LoadedRunInput<TContext> = {
  run: RunRecordData;
  thread: ThreadMetadata;
  threadRef: ThreadRef;
  userMessage: UserMessageItem;
  runtimeConfig: AgentRuntimeConfig;
  context: TContext;
};

/**
 * Store-backed Managed Agent worker.
 *
 * The worker is the durable Inngest callback path: it restores Run/Thread/
 * Message state from the configured store, invokes the stateless Agent Runtime,
 * then projects runtime output back into RunStep and assistant Message facts.
 */
export class ManagedRunWorker<TContext = StoreContext> {
  private readonly store: ManagedRunStore<TContext>;
  private readonly runtimeDriver: RunExecutionBackend;
  private readonly leaseOwner: string;
  private readonly leaseDurationSeconds: number;

  public constructor(options: ManagedRunWorkerOptions<TContext>) {
    this.store = options.store;
    this.runtimeDriver = options.runtimeDriver;
    this.leaseOwner = options.leaseOwner ?? `worker-${Math.random().toString(36).slice(2)}`;
    this.leaseDurationSeconds = options.leaseDurationSeconds ?? 300;
  }

  public async executeRun(runId: string, context: TContext): Promise<ManagedRunExecutionResult> {
    const claimed = await this.claimRun(runId, context);
    if (!claimed) {
      return { runId, status: 'skipped' };
    }

    const loaded = await this.loadRunInput(runId, context);
    const { run, thread, threadRef, userMessage, runtimeConfig } = loaded;

    if (!this.canExecuteClaimedRun(run)) {
      return { runId, status: 'skipped' };
    }

    const assistantItem = await this.createAssistantMessage(thread, context);
    await this.store.addThreadItem(threadRef, assistantItem, context);
    await this.markRunStarted(run, context);

    let fullText = '';
    let runtimeError: string | undefined;

    for await (
      const event of this.runtimeDriver.start({
        runId: run.id,
        threadId: thread.id,
        prompt: run.prompt ?? '',
        conversation: await this.loadConversation(threadRef, userMessage.id, context),
        config: runtimeConfig,
        authBindingId: this.authBindingIdFromRun(run),
        context: context as StoreContext,
      })
    ) {
      const cancellation = await this.checkCancellation(run, context);
      if (cancellation) {
        assistantItem.status = 'incomplete';
        assistantItem.content = [{ type: 'output_text', text: fullText }];
        await this.store.saveItem(threadRef, assistantItem, context);
        return { runId, status: cancellation };
      }

      if (event.type === 'text') {
        fullText += event.text;
        await this.appendRunStep(run, RunStepType.TEXT_DELTA, context, {
          message: event.text,
          data: { delta: event.text },
        });
        continue;
      }

      if (event.type === 'auth_required' || event.type === 'tool_call' || event.type === 'waiting_runner') {
        const terminalStatus = await this.handleRuntimeControlEvent(event, run, assistantItem, threadRef, context, fullText);
        if (terminalStatus) {
          return { runId, status: terminalStatus };
        }
        continue;
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
    const finalStatus = runtimeError ? RunStatus.FAILED : RunStatus.COMPLETED;
    await this.finishRun(run, finalStatus, context, runtimeError);
    return { runId, status: finalStatus };
  }

  private async claimRun(runId: string, context: TContext): Promise<boolean> {
    const now = nowTimestamp();
    const run = this.store.claimRun
      ? await this.store.claimRun({
        runId,
        leaseOwner: this.leaseOwner,
        leaseExpiresAt: now + this.leaseDurationSeconds,
        now,
      }, context)
      : await this.claimRunWithSave(runId, context, now);
    if (!run) {
      return false;
    }
    if (run.cancelRequestedAt) {
      run.status = RunStatus.CANCELLED;
      run.completedAt = now;
      run.updatedAt = now;
      run.leaseOwner = undefined;
      run.leaseExpiresAt = undefined;
      await this.store.saveRun(run, context);
      await this.appendRunStep(run, RunStepType.CANCELLED, context, {
        message: 'Run cancelled before start',
        data: { status: RunStatus.CANCELLED },
      });
      return false;
    }
    return true;
  }

  private async claimRunWithSave(runId: string, context: TContext, now: number): Promise<RunRecordData | undefined> {
    const run = await this.store.loadRun(runId, context);
    if (!canClaimRun(run, { leaseOwner: this.leaseOwner, now })) {
      return undefined;
    }

    run.leaseOwner = this.leaseOwner;
    run.leaseExpiresAt = now + this.leaseDurationSeconds;
    run.heartbeatAt = now;
    run.updatedAt = now;
    await this.store.saveRun(run, context);

    const claimed = await this.store.loadRun(runId, context);
    return claimed.leaseOwner === this.leaseOwner ? claimed : undefined;
  }

  private canExecuteClaimedRun(run: RunRecordData): boolean {
    if (run.leaseOwner !== this.leaseOwner) {
      return false;
    }
    return run.status === RunStatus.QUEUED || run.status === RunStatus.RUNNING;
  }

  private async checkCancellation(run: RunRecordData, context: TContext): Promise<RunRecordData['status'] | undefined> {
    const latest = await this.store.loadRun(run.id, context);
    if (!latest.cancelRequestedAt) {
      return undefined;
    }
    await this.finishRun(run, RunStatus.CANCELLED, context, 'Run cancellation requested');
    await this.appendRunStep(run, RunStepType.CANCELLED, context, {
      message: 'Run cancelled',
      data: { status: RunStatus.CANCELLED },
    });
    return RunStatus.CANCELLED;
  }

  public async loadExecutionInput(runId: string, context: TContext): Promise<RunExecutionInput> {
    const loaded = await this.loadRunInput(runId, context);
    return {
      runId: loaded.run.id,
      threadId: loaded.thread.id,
      prompt: loaded.run.prompt ?? '',
      conversation: await this.loadConversation(loaded.threadRef, loaded.userMessage.id, context),
      config: loaded.runtimeConfig,
      authBindingId: this.authBindingIdFromRun(loaded.run),
      context: context as StoreContext,
    };
  }

  private async loadRunInput(runId: string, context: TContext): Promise<LoadedRunInput<TContext>> {
    const run = await this.store.loadRun(runId, context);
    const threadRef = this.threadRefFromRun(run);
    const thread = await this.store.loadThread(threadRef, context);
    const userMessage = await this.resolveUserMessage(run, threadRef, context);
    return {
      run,
      thread,
      threadRef,
      userMessage,
      runtimeConfig: this.resolveRuntimeConfig(run, thread),
      context,
    };
  }

  private async resolveUserMessage(
    run: RunRecordData,
    threadRef: ThreadRef,
    context: TContext,
  ): Promise<UserMessageItem> {
    const metadataUserMessageId = run.metadata?.userMessageId;
    if (typeof metadataUserMessageId === 'string' && metadataUserMessageId.length > 0) {
      const item = await this.store.loadItem(threadRef, metadataUserMessageId, context);
      if (item.type === 'user_message') {
        return item as UserMessageItem;
      }
      throw new Error(`Run userMessageId does not point to a user message: ${metadataUserMessageId}`);
    }

    const items = await this.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    const prompt = run.prompt?.trim();
    const candidates = items.data.filter((item): item is UserMessageItem => item.type === 'user_message');
    const matching = prompt
      ? candidates.find((item) => extractUserMessageText(item.content).trim() === prompt)
      : undefined;
    const fallback = matching ?? candidates[candidates.length - 1];
    if (!fallback) {
      throw new Error(`Cannot restore Run input without a user message: ${run.id}`);
    }
    return fallback;
  }

  private resolveRuntimeConfig(run: RunRecordData, thread: ThreadMetadata): AgentRuntimeConfig {
    const fromRun = this.asRuntimeConfig(run.metadata?.runtimeConfig);
    if (fromRun) {
      return fromRun;
    }

    const runtime = (thread.metadata as Record<string, unknown> | undefined)?.runtime;
    const fromThread = this.asRuntimeConfig(runtime);
    if (fromThread) {
      return fromThread;
    }

    if (!isWorkspaceRef(run.workspace)) {
      throw new Error('Run workspace reference is required');
    }
    return {
      workspace: run.workspace,
      runner: this.parseRunner(run.runner),
    };
  }

  private authBindingIdFromRun(run: RunRecordData): string | undefined {
    const authBindingId = run.metadata?.authBindingId;
    if (typeof authBindingId === 'string' && authBindingId.length > 0) {
      return authBindingId;
    }
    const authBinding = run.metadata?.authBinding;
    if (authBinding && typeof authBinding === 'object') {
      const id = (authBinding as { id?: unknown }).id;
      return typeof id === 'string' && id.length > 0 ? id : undefined;
    }
    return undefined;
  }

  private asRuntimeConfig(value: unknown): AgentRuntimeConfig | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const candidate = value as Partial<AgentRuntimeConfig>;
    if (!isWorkspaceRef(candidate.workspace) || !candidate.runner) {
      return undefined;
    }
    const runnerType = candidate.runner.type;
    if (!this.isRunnerType(runnerType)) {
      return undefined;
    }
    return {
      ...candidate,
      workspace: candidate.workspace,
      runner: {
        ...candidate.runner,
        type: runnerType,
        protocol: candidate.runner.protocol === 'acp' ? 'acp' : 'pi',
      },
    } as AgentRuntimeConfig;
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

  private async handleRuntimeControlEvent(
    event: AgentRuntimeEvent,
    run: RunRecordData,
    assistantItem: AssistantMessageItem,
    threadRef: ThreadRef,
    context: TContext,
    fullText: string,
  ): Promise<RunRecordData['status'] | undefined> {
    if (event.type === 'auth_required') {
      await this.appendRunStep(run, RunStepType.AUTH_REQUIRED, context, {
        message: event.message,
        data: {
          method: event.method,
          url: event.url,
          options: event.options,
        },
      });
      return undefined;
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
      assistantItem.status = 'incomplete';
      assistantItem.content = [{ type: 'output_text', text: fullText }];
      await this.store.saveItem(threadRef, assistantItem, context);
      await this.finishRun(run, RunStatus.WAITING_INPUT, context, `Tool call ${event.name} requires steering`);
      return RunStatus.WAITING_INPUT;
    }

    if (event.type === 'waiting_runner') {
      await this.appendRunStep(run, RunStepType.WAITING_RUNNER, context, {
        message: event.message,
        data: { workspace: event.workspace },
      });
      assistantItem.status = 'incomplete';
      assistantItem.content = [{ type: 'output_text', text: fullText }];
      await this.store.saveItem(threadRef, assistantItem, context);
      await this.finishRun(run, RunStatus.WAITING_RUNNER, context, event.message);
      return RunStatus.WAITING_RUNNER;
    }

    return undefined;
  }

  private async markRunStarted(run: RunRecordData, context: TContext): Promise<void> {
    const now = nowTimestamp();
    run.status = RunStatus.RUNNING;
    run.startedAt = now;
    run.heartbeatAt = now;
    run.updatedAt = now;
    await this.store.saveRun(run, context);
    await this.appendRunStep(run, RunStepType.STARTED, context, {
      message: 'Run started',
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
    run.completedAt = RUN_WAITING_STATUSES.has(status) ? undefined : now;
    run.heartbeatAt = now;
    run.leaseOwner = undefined;
    run.leaseExpiresAt = undefined;
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
        commandKind: run.commandKind,
        surfaceId: run.surfaceId,
        createdAt,
      }),
      commandKind: run.commandKind,
      surfaceId: run.surfaceId,
      runId: run.id,
      run: this.resolveRunResource(run, context),
      type,
      message: options.message,
      data: options.data,
      createdAt,
    }, context);
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
        const text = extractUserMessageText(item.content).trim();
        if (text) {
          conversation.push({ role: 'user', text, createdAt: item.created_at });
        }
        continue;
      }
      if (item.type === 'assistant_message' && item.status !== 'in_progress') {
        const text = extractAssistantMessageText(item.content).trim();
        if (text) {
          conversation.push({ role: 'assistant', text, createdAt: item.created_at });
        }
      }
    }

    return conversation;
  }

  private threadRefFromRun(run: RunRecordData): ThreadRef {
    if (/^https?:\/\//.test(run.thread)) {
      return { thread_id: run.thread as `http://${string}` | `https://${string}` };
    }
    return toThreadRef({
      thread_id: this.extractThreadId(run.thread),
      chat_id: run.surfaceId,
    });
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
}
