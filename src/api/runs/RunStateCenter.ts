import type { ChatKitStore, StoreContext } from '../chatkit/store';
import type {
  AssistantMessageItem,
  ClientEffect,
  ClientToolCallItem,
  ThreadItem,
  ThreadMetadata,
  ThreadRef,
  UserMessageItem,
} from '../chatkit/types';
import {
  DEFAULT_THREAD_CHAT_ID,
  extractAssistantMessageText,
  extractUserMessageText,
  generateId,
  toThreadRef,
  nowTimestamp,
} from '../chatkit/types';
import type { AgentRuntimeConfig, RunnerProtocol, RunnerType } from './AgentRuntimeTypes';
import type { AgentRuntimeEvent } from './AgentRuntimeTypes';
import { InngestRunExecutionBackend } from './InngestRunExecutionBackend';
import type { RunExecutionBackend } from './RunExecutionBackend';
import { isWorkspaceUri } from '../workspace/types';
import { XpodRunStepType as RunStepType, RunStatus } from './schema';
import {
  generateRunResourceId,
  generateRunStepResourceId,
  resolveDataResourceIri,
  resolveRunUrn,
  type RunRecordData,
  type RunStepRecordData,
  type RunStore,
} from './store';

export type RunStateEvent =
  | { type: 'item_added'; item: ThreadItem }
  | { type: 'item_updated'; itemId: string; delta: string }
  | { type: 'item_done'; item: ThreadItem }
  | { type: 'client_effect'; effect: ClientEffect }
  | { type: 'error'; code: string; message: string };

const RUN_WAITING_STATUSES = new Set<string>([
  RunStatus.WAITING_INPUT,
  RunStatus.WAITING_RUNNER,
]);

type ActiveAssistant = {
  item: AssistantMessageItem;
  fullText: string;
};

type RuntimeProjectionResult =
  | { action: 'continue' }
  | { action: 'return' }
  | { action: 'error'; message: string };

export interface RunStateCenterOptions<TContext = StoreContext> {
  store: ChatKitStore<TContext>;
  enableAgentRuntime?: boolean;
  executionBackend?: RunExecutionBackend;
}

/**
 * Run is the xpod-side state center for Agent execution.
 *
 * ChatKit and Task APIs are command surfaces. They hand execution to this
 * center, which persists first-class Run/RunStep facts through the configured
 * RunStore while projecting visible output back to Thread/Message.
 */
export class RunStateCenter<TContext = StoreContext> {
  private readonly store: ChatKitStore<TContext>;
  private readonly runStore?: RunStore<TContext>;
  private readonly enableAgentRuntime: boolean;
  private readonly executionBackend: RunExecutionBackend;

  public constructor(options: RunStateCenterOptions<TContext>) {
    this.store = options.store;
    this.runStore = this.resolveRunStore(options.store);
    this.enableAgentRuntime = options.enableAgentRuntime ?? false;
    this.executionBackend = options.executionBackend ?? new InngestRunExecutionBackend();
  }

  public getAgentRuntimeConfig(thread: ThreadMetadata, context?: TContext): AgentRuntimeConfig | null {
    if (!this.enableAgentRuntime) {
      return null;
    }
    const runtime = (thread.metadata as any)?.runtime;
    if (!runtime) {
      return null;
    }
    if (!runtime.runner) {
      throw new Error('Invalid thread.metadata.runtime: runner is required');
    }
    const runnerType = runtime.runner.type as RunnerType;
    if (!runnerType) {
      throw new Error('Invalid thread.metadata.runtime.runner.type');
    }

    const protocol = this.resolveRunnerProtocol(runtime.runner.protocol);
    const allowCustomArgv = runtime.runner.allowCustomArgv === true;
    const argv = allowCustomArgv ? runtime.runner.argv : undefined;
    const workspace = this.resolveWorkspaceUri(runtime.workspace, thread.workspace);
    if (!workspace) {
      throw new Error('Invalid thread runtime: workspace URI is required');
    }

    return {
      ...runtime,
      workspace,
      runner: {
        ...runtime.runner,
        argv,
        protocol,
      },
      agentConfig: runtime.agentConfig,
    } as AgentRuntimeConfig;
  }

  public getDefaultAgentRuntimeConfig(context: TContext): AgentRuntimeConfig | null {
    if (!this.enableAgentRuntime) {
      return null;
    }
    return null;
  }

  private resolveRunnerProtocol(protocol: unknown): RunnerProtocol {
    if (protocol === 'acp' || protocol === 'pi') {
      return protocol;
    }
    return 'pi';
  }

  private resolveWorkspaceUri(runtimeWorkspace: unknown, threadWorkspace: AgentRuntimeConfig['workspace'] | undefined): AgentRuntimeConfig['workspace'] | undefined {
    if (isWorkspaceUri(runtimeWorkspace)) {
      return runtimeWorkspace;
    }
    return isWorkspaceUri(threadWorkspace) ? threadWorkspace : undefined;
  }

  public async *startAgentRun(input: {
    thread: ThreadMetadata;
    userMessage: UserMessageItem;
    context: TContext;
    runtimeConfig: AgentRuntimeConfig;
  }): AsyncIterable<RunStateEvent> {
    const { thread, userMessage, context, runtimeConfig } = input;
    const prompt = extractUserMessageText(userMessage.content);
    if (!prompt.trim()) {
      return;
    }

    const threadRef = this.threadRefFromThread(thread);
    const assistantItem = await this.createAssistantMessage(thread, context);
    const run = await this.createRun({
      thread,
      userMessage,
      prompt,
      runtimeConfig,
      context,
    });

    await this.store.addThreadItem(threadRef, assistantItem, context);
    yield { type: 'item_added', item: assistantItem };
    await this.markRunStarted(run, context);

    const assistantState: ActiveAssistant = { item: assistantItem, fullText: '' };
    let runtimeError: string | undefined;

    for await (
      const event of this.executionBackend.start({
        runId: run.id,
        threadId: thread.id,
        prompt,
        conversation: await this.loadConversation(threadRef, userMessage.id, context),
        config: runtimeConfig,
        context: context as StoreContext,
      })
    ) {
      const cancellation = await this.checkCancellation(run, threadRef, assistantState, context);
      if (cancellation) {
        yield { type: 'item_done', item: cancellation };
        yield { type: 'error', code: 'runtime_cancelled', message: 'Run cancellation requested' };
        return;
      }

      const result = yield* this.projectRuntimeEvent(event, {
        run,
        thread,
        threadRef,
        assistant: assistantState,
        context,
      });
      if (result.action === 'continue') {
        continue;
      }
      if (result.action === 'return') {
        return;
      }

      runtimeError = result.message;
      break;
    }

    const finalStatus = runtimeError ? 'incomplete' : 'completed';
    const finalItem = this.finalizeAssistantMessage(assistantState.item, assistantState.fullText, finalStatus);
    await this.store.saveItem(threadRef, finalItem, context);
    await this.finishRun(
      run,
      runtimeError ? RunStatus.FAILED : RunStatus.COMPLETED,
      context,
      runtimeError,
    );
    yield { type: 'item_done', item: finalItem };
  }

  public async *completeClientToolOutput(input: {
    threadRef: ThreadRef;
    itemId: string;
    output: string;
    context: TContext;
  }): AsyncIterable<RunStateEvent> {
    const { threadRef, itemId, output, context } = input;
    const item = await this.store.loadItem(threadRef, itemId, context);
    if (item.type !== 'client_tool_call') {
      return;
    }

    const updatedItem: ClientToolCallItem = {
      ...item,
      output,
      status: 'completed',
    };
    await this.store.saveItem(threadRef, updatedItem, context);
    yield { type: 'item_done', item: updatedItem };

    const run = await this.resolveWaitingRunForToolOutput(updatedItem, threadRef, context);
    if (!run) {
      return;
    }

    const now = nowTimestamp();
    await this.appendRunStep(run, RunStepType.CLIENT_TOOL_OUTPUT, context, {
      message: updatedItem.name,
      data: {
        itemId: updatedItem.id,
        callId: updatedItem.call_id,
        output,
      },
    });
    await this.appendRunStep(run, RunStepType.CONTINUE_REQUESTED, context, {
      message: 'Run continuation requested',
      data: {
        kind: 'client_tool_output',
        itemId: updatedItem.id,
      },
    });
    run.status = RunStatus.QUEUED;
    run.leaseOwner = undefined;
    run.leaseExpiresAt = undefined;
    run.completedAt = undefined;
    run.error = undefined;
    run.updatedAt = now;
    run.metadata = {
      ...(run.metadata ?? {}),
      continuation: {
        kind: 'client_tool_output',
        itemId: updatedItem.id,
        output,
        queuedAt: now,
      },
    };
    await this.saveRun(run, context);

    const thread = await this.store.loadThread(threadRef, context);
    const assistantItemId = typeof run.metadata?.assistantItemId === 'string' ? run.metadata.assistantItemId : undefined;
    const assistantItem = assistantItemId
      ? await this.store.loadItem(threadRef, assistantItemId, context) as AssistantMessageItem
      : await this.createAssistantMessage(thread, context);
    if (!assistantItemId) {
      await this.store.addThreadItem(threadRef, assistantItem, context);
      yield { type: 'item_added', item: assistantItem };
    }
    const assistantState: ActiveAssistant = {
      item: assistantItem,
      fullText: extractAssistantMessageText(assistantItem.content),
    };
    await this.markRunStarted(run, context);

    for await (
      const event of this.executionBackend.start({
        runId: run.id,
        threadId: this.extractThreadIdFromRef(threadRef),
        prompt: this.buildContinuationPrompt(updatedItem),
        conversation: await this.loadConversation(threadRef, String(run.metadata?.userMessageId ?? updatedItem.id), context),
        config: this.resolveRuntimeConfigForContinuation(run),
        continuation: {
          kind: 'client_tool_output',
          itemId: updatedItem.id,
        },
        context: context as StoreContext,
      })
    ) {
      const cancellation = await this.checkCancellation(run, threadRef, assistantState, context);
      if (cancellation) {
        yield { type: 'item_done', item: cancellation };
        yield { type: 'error', code: 'runtime_cancelled', message: 'Run cancellation requested' };
        return;
      }

      const result = yield* this.projectRuntimeEvent(event, {
        run,
        thread,
        threadRef,
        assistant: assistantState,
        context,
      });
      if (result.action === 'continue') {
        continue;
      }
      if (result.action === 'return') {
        return;
      }
      const finalItem = this.finalizeAssistantMessage(assistantState.item, assistantState.fullText, 'incomplete');
      await this.store.saveItem(threadRef, finalItem, context);
      await this.finishRun(run, RunStatus.FAILED, context, result.message);
      yield { type: 'item_done', item: finalItem };
      return;
    }

    const finalItem = this.finalizeAssistantMessage(assistantState.item, assistantState.fullText, 'completed');
    await this.store.saveItem(threadRef, finalItem, context);
    await this.finishRun(run, RunStatus.COMPLETED, context);
    yield { type: 'item_done', item: finalItem };
  }

  private resolveRunStore(store: ChatKitStore<TContext>): RunStore<TContext> | undefined {
    if (
      typeof store.saveRun === 'function'
      && typeof store.loadRun === 'function'
      && typeof store.listRuns === 'function'
      && typeof store.appendRunStep === 'function'
      && typeof store.loadRunSteps === 'function'
    ) {
      return store as RunStore<TContext>;
    }
    return undefined;
  }

  private async createRun(input: {
    thread: ThreadMetadata;
    userMessage: UserMessageItem;
    prompt: string;
    runtimeConfig: AgentRuntimeConfig;
    context: TContext;
  }): Promise<RunRecordData> {
    const { thread, userMessage, prompt, runtimeConfig, context } = input;
    const now = nowTimestamp();
    const commandKind = thread.metadata?.commandKind === 'task' ? 'task' : 'chat';
    const surfaceId = this.resolveSurfaceId(thread);
    const run: RunRecordData = {
      id: generateRunResourceId({
        key: generateId('run'),
        commandKind,
        surfaceId,
        createdAt: now,
      }),
      thread: this.resolveThreadUri(thread, context),
      workspace: runtimeConfig.workspace,
      commandKind,
      surfaceId,
      status: RunStatus.QUEUED,
      runner: `${runtimeConfig.runner.protocol ?? 'pi'}:${runtimeConfig.runner.type}`,
      prompt,
      metadata: {
        threadId: thread.id,
        userMessageId: userMessage.id,
        runtimeConfig,
        surfaceId,
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.saveRun(run, context);
    await this.appendRunStep(run, RunStepType.CREATED, context, {
      message: 'Run created',
      data: {
        commandKind: run.commandKind,
        thread: run.thread,
        workspace: run.workspace,
        runner: run.runner,
      },
    });
    return run;
  }

  private async markRunStarted(run: RunRecordData, context: TContext): Promise<void> {
    const now = nowTimestamp();
    run.status = RunStatus.RUNNING;
    run.startedAt = now;
    run.updatedAt = now;
    await this.saveRun(run, context);
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
    run.completedAt = now;
    run.updatedAt = now;
    run.error = error;
    await this.saveRun(run, context);
    await this.appendRunStep(
      run,
      this.stepTypeForTerminalStatus(status),
      context,
      {
        message: error ?? `Run ${status}`,
        data: { status },
      },
    );
  }

  private async pauseRun(
    run: RunRecordData,
    status: RunRecordData['status'],
    context: TContext,
    message: string,
  ): Promise<void> {
    const now = nowTimestamp();
    run.status = status;
    run.completedAt = undefined;
    run.heartbeatAt = now;
    run.leaseOwner = undefined;
    run.leaseExpiresAt = undefined;
    run.updatedAt = now;
    run.error = message;
    await this.saveRun(run, context);
  }

  private async *projectRuntimeEvent(
    event: AgentRuntimeEvent,
    input: {
      run: RunRecordData;
      thread: ThreadMetadata;
      threadRef: ThreadRef;
      assistant: ActiveAssistant;
      context: TContext;
    },
  ): AsyncGenerator<RunStateEvent, RuntimeProjectionResult> {
    const { run, thread, threadRef, assistant, context } = input;

    if (event.type === 'text') {
      assistant.fullText += event.text;
      await this.appendRunStep(run, RunStepType.TEXT_DELTA, context, {
        message: event.text,
        data: { delta: event.text },
      });
      yield { type: 'item_updated', itemId: assistant.item.id, delta: event.text };
      return { action: 'continue' };
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
      yield {
        type: 'client_effect',
        effect: {
          effect_type: 'runtime.auth_required',
          data: {
            method: event.method,
            url: event.url,
            message: event.message,
            options: event.options,
          },
        },
      };
      return { action: 'continue' };
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
      const toolItem: ClientToolCallItem = {
        id: this.store.generateItemId('client_tool_call', thread, context),
        thread_id: thread.id,
        type: 'client_tool_call',
        name: event.name,
        arguments: event.arguments,
        call_id: event.requestId,
        status: 'pending',
        metadata: {
          runId: run.id,
          assistantItemId: assistant.item.id,
        },
        created_at: nowTimestamp(),
      };
      await this.store.addThreadItem(threadRef, toolItem, context);
      yield { type: 'item_added', item: toolItem };

      const incomplete = this.finalizeAssistantMessage(assistant.item, assistant.fullText, 'incomplete');
      assistant.item = incomplete;
      await this.store.saveItem(threadRef, incomplete, context);
      yield { type: 'item_done', item: incomplete };
      run.metadata = {
        ...(run.metadata ?? {}),
        assistantItemId: assistant.item.id,
        waitingTool: {
          itemId: toolItem.id,
          requestId: event.requestId,
          name: event.name,
        },
      };
      await this.pauseRun(run, RunStatus.WAITING_INPUT, context, `Waiting for client tool output: ${event.name}`);
      yield {
        type: 'error',
        code: 'runtime_waiting_input',
        message: `Run is waiting for client tool output: ${event.name}`,
      };
      return { action: 'return' };
    }

    if (event.type === 'waiting_runner') {
      await this.appendRunStep(run, RunStepType.WAITING_RUNNER, context, {
        message: event.message,
        data: {
          workspace: event.workspace,
        },
      });
      yield { type: 'error', code: 'waiting_runner', message: event.message };
      await this.finishRun(run, RunStatus.WAITING_RUNNER, context, event.message);
      return { action: 'return' };
    }

    await this.appendRunStep(run, RunStepType.ERROR, context, {
      message: event.message,
    });
    yield { type: 'error', code: 'runtime_error', message: event.message };
    return { action: 'error', message: event.message };
  }

  private async checkCancellation(
    run: RunRecordData,
    threadRef: ThreadRef,
    assistant: ActiveAssistant,
    context: TContext,
  ): Promise<AssistantMessageItem | undefined> {
    if (!this.runStore?.loadRun) {
      return undefined;
    }
    const latest = await this.runStore.loadRun(run.id, context);
    if (!latest.cancelRequestedAt) {
      return undefined;
    }
    run.cancelRequestedAt = latest.cancelRequestedAt;
    const finalItem = this.finalizeAssistantMessage(assistant.item, assistant.fullText, 'incomplete');
    assistant.item = finalItem;
    await this.store.saveItem(threadRef, finalItem, context);
    await this.finishRun(run, RunStatus.CANCELLED, context, 'Run cancellation requested');
    return finalItem;
  }

  private stepTypeForTerminalStatus(status: RunRecordData['status']): RunStepRecordData['type'] {
    if (status === RunStatus.COMPLETED) {
      return RunStepType.COMPLETED;
    }
    if (status === RunStatus.CANCELLED) {
      return RunStepType.CANCELLED;
    }
    if (RUN_WAITING_STATUSES.has(status)) {
      return status === RunStatus.WAITING_RUNNER ? RunStepType.WAITING_RUNNER : RunStepType.WAITING_INPUT;
    }
    return RunStepType.FAILED;
  }

  private async saveRun(run: RunRecordData, context: TContext): Promise<void> {
    await this.runStore?.saveRun(run, context);
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
    await this.runStore?.appendRunStep({
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
      run: this.resolveRunUri(run, context),
      type,
      message: options.message,
      data: options.data,
      createdAt,
    }, context);
  }

  private resolveThreadUri(thread: ThreadMetadata, context: TContext): string {
    const threadId = thread.id;
    if (/^https?:\/\//.test(threadId)) {
      return threadId;
    }

    const commandKind = thread.metadata?.commandKind === 'task' ? 'task' : 'chat';
    const surfaceId = this.resolveSurfaceId(thread);
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl) {
      if (threadId.includes('#') && !threadId.startsWith('#')) {
        return resolveDataResourceIri(podBaseUrl, threadId);
      }
      return `${podBaseUrl}/.data/${commandKind}/${surfaceId}/index.ttl#${threadId}`;
    }
    return `urn:xpod:thread:${commandKind}:${encodeURIComponent(surfaceId)}:${encodeURIComponent(threadId)}`;
  }

  private resolveRunUri(run: RunRecordData, context: TContext): string {
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl) {
      return resolveDataResourceIri(podBaseUrl, run.id);
    }
    return resolveRunUrn(run.id);
  }

  private async resolveWaitingRunForToolOutput(
    item: ClientToolCallItem,
    threadRef: ThreadRef,
    context: TContext,
  ): Promise<RunRecordData | undefined> {
    const metadataRunId = item.metadata?.runId;
    if (typeof metadataRunId === 'string' && this.runStore?.loadRun) {
      const run = await this.runStore.loadRun(metadataRunId, context);
      if (run.status === RunStatus.WAITING_INPUT) {
        return run;
      }
    }

    if (!this.runStore?.listRuns) {
      return undefined;
    }

    const threadCandidates = this.threadCandidatesForRunLookup(threadRef, context);
    for (const thread of threadCandidates) {
      const candidates = await this.runStore.listRuns({
        thread,
        status: RunStatus.WAITING_INPUT,
        limit: 10,
      }, context);
      const match = candidates.find((run) => {
        const tool = run.metadata?.waitingTool;
        return !tool || typeof tool !== 'object' || (tool as any).itemId === item.id;
      }) ?? candidates[0];
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  private extractThreadIdFromRef(threadRef: ThreadRef): string {
    if ('chat_id' in threadRef) {
      return threadRef.thread_id;
    }
    return threadRef.thread_id;
  }

  private threadCandidatesForRunLookup(threadRef: ThreadRef, context: TContext): string[] {
    const candidates: string[] = [];
    const add = (value: string | undefined): void => {
      if (value && !candidates.includes(value)) {
        candidates.push(value);
      }
    };

    const threadId = this.extractThreadIdFromRef(threadRef);
    add(threadId);
    const relative = this.extractBaseRelativeThreadId(threadId);
    add(relative);
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl && relative) {
      add(resolveDataResourceIri(podBaseUrl, relative));
    }
    return candidates;
  }

  private extractBaseRelativeThreadId(threadId: string): string | undefined {
    if (/^(chat|task)\/[^/]+\/index\.ttl#[^#]+$/.test(threadId)) {
      return threadId;
    }
    if (!/^https?:\/\//.test(threadId)) {
      return undefined;
    }
    try {
      const url = new URL(threadId);
      const marker = '/.data/';
      const index = url.pathname.indexOf(marker);
      if (index >= 0 && url.hash) {
        return `${url.pathname.slice(index + marker.length)}${url.hash}`;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private buildContinuationPrompt(item: ClientToolCallItem): string {
    return `Continue the previous run after client tool output.\n\nTool: ${item.name}\nOutput:\n${item.output ?? ''}`;
  }

  private resolveRuntimeConfigForContinuation(run: RunRecordData): AgentRuntimeConfig {
    const runtimeConfig = run.metadata?.runtimeConfig;
    if (runtimeConfig && typeof runtimeConfig === 'object') {
      return runtimeConfig as AgentRuntimeConfig;
    }
    if (!isWorkspaceUri(run.workspace)) {
      throw new Error('Run workspace URI is required');
    }
    const [protocol, type] = run.runner.split(':');
    return {
      workspace: run.workspace,
      runner: {
        protocol: protocol === 'acp' ? 'acp' : 'pi',
        type: this.isRunnerType(type) ? type : 'pi',
      },
    };
  }

  private isRunnerType(value: unknown): value is RunnerType {
    return value === 'pi' || value === 'codex' || value === 'claude' || value === 'codebuddy';
  }

  private resolveSurfaceId(thread: ThreadMetadata): string {
    if (typeof thread.metadata?.surface_id === 'string') {
      return thread.metadata.surface_id;
    }
    if (typeof thread.metadata?.chat_id === 'string') {
      return thread.metadata.chat_id;
    }
    return DEFAULT_THREAD_CHAT_ID;
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

  private finalizeAssistantMessage(
    item: AssistantMessageItem,
    text: string,
    status: 'completed' | 'incomplete',
  ): AssistantMessageItem {
    return {
      ...item,
      content: [{ type: 'output_text', text }],
      status,
    };
  }

  private threadRefFromThread(thread: ThreadMetadata): ThreadRef {
    return toThreadRef({
      thread_id: thread.id,
      chat_id: typeof thread.metadata?.chat_id === 'string' ? thread.metadata.chat_id : DEFAULT_THREAD_CHAT_ID,
    });
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
}
