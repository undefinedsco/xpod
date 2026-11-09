/** Constant-only Task diagnostics. Never classify arbitrary upstream messages. */
export const TASK_FAILURE_CODES = [
  'TASK_EXECUTION_ERROR', 'TASK_RUNTIME_ERROR', 'TASK_STATE_READ_ERROR',
  'TASK_BACKGROUND_ERROR', 'TASK_DIAGNOSTIC_UNAVAILABLE',
] as const;
export const TASK_FAILURE_STAGES = [
  'prepare_execution', 'create_assistant', 'save_assistant_initial', 'mark_run_started', 'save_started',
  'update_started_session', 'append_started_step', 'load_conversation', 'retrieve_context',
  'start_cancellation_monitor', 'start_backend', 'read_current_run', 'append_text_step',
  'append_auth_step', 'append_tool_step', 'save_tool_item', 'persist_approval',
  'persist_waiting', 'save_waiting_assistant', 'append_runtime_error',
  'append_waiting_step', 'persist_terminal', 'save_terminal_assistant', 'save_task_terminal', 'unknown',
] as const;
export type TaskFailureCode = typeof TASK_FAILURE_CODES[number];
export type TaskFailureStage = typeof TASK_FAILURE_STAGES[number];
export interface TaskRunFailureDiagnostic {
  code: TaskFailureCode;
  stage: TaskFailureStage;
  status: 'failed';
}
export function projectTaskRunFailureDiagnostic(value: unknown, status: string): TaskRunFailureDiagnostic | undefined {
  if (status !== 'failed' || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== 'failed'
    || !TASK_FAILURE_CODES.some(code => code === record.code)
    || !TASK_FAILURE_STAGES.some(stage => stage === record.stage)) return undefined;
  return { code: record.code as TaskFailureCode, stage: record.stage as TaskFailureStage, status: 'failed' };
}
