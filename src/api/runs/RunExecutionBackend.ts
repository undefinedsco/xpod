import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
} from './AgentRuntimeTypes';
import type { StoreContext } from '../chatkit/store';

export type RunConversationMessage =
  | { role: 'user'; text: string; createdAt: number }
  | { role: 'assistant'; text: string; createdAt: number };

export interface RunExecutionInput {
  runId: string;
  threadId: string;
  prompt: string;
  /**
   * Durable conversation projection loaded by Xpod from Pod state before this
   * execution starts. Runtime drivers must treat their own sessions as
   * request-scoped caches and restore from this input on every run.
   */
  conversation: RunConversationMessage[];
  config: AgentRuntimeConfig;
  /**
   * Server-side auth binding used by unattended/durable Run callbacks to
   * restore Pod access without serializing secrets into queue events.
   */
  authBindingId?: string;
  /**
   * Present when a paused Run is being placed back on the execution queue.
   * This does not create a new Run; it resumes the same message-level Run
   * after external input such as a client tool result or approval.
   */
  continuation?: {
    kind: 'client_tool_output' | 'approval' | 'user_input';
    itemId?: string;
  };
  /**
   * Optional request context for in-process enqueue adapters. Durable workers
   * must restore Pod access from non-secret event data or service-side lookup;
   * access tokens must not be serialized into external queues.
   */
  context?: StoreContext;
}

/**
 * Execution boundary for an already-created Xpod Run.
 *
 * Implementations may enqueue, kick, or execute inline, but they must not own
 * the business state for the run. Pod-backed Run/Thread/Message/RunStep state
 * stays authoritative; backend ids are diagnostics only.
 */
export interface RunExecutionBackend {
  start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent>;
}

export interface RunEnqueueResult {
  runId: string;
  externalRunId?: string;
}
