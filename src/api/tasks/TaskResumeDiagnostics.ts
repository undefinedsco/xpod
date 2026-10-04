/** Fixed resume boundaries, never derived from error prose or caller metadata. */
export const TASK_RESUME_STAGES = [
  'route_request', 'route_validation', 'route_run_read', 'run_read', 'approval_validation',
  'checkpoint_validation', 'task_lookup', 'task_auth_restore', 'invocation_issue',
  'continuation_prepare', 'continuation_complete', 'continuation_release', 'run_result_read',
] as const;
export type TaskResumeStage = typeof TASK_RESUME_STAGES[number];
const stages = new WeakMap<Error, TaskResumeStage>();

export function getTaskResumeStage(error: unknown): TaskResumeStage | undefined {
  return error instanceof Error ? stages.get(error) : undefined;
}

/** First inner boundary wins; frozen errors and original throw semantics are preserved. */
export async function withTaskResumeStage<T>(stage: TaskResumeStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error && TASK_RESUME_STAGES.includes(stage) && !stages.has(error)) stages.set(error, stage);
    throw error;
  }
}

export const TASK_RESUME_ERROR_TYPES = ['error', 'type_error', 'range_error', 'syntax_error', 'non_error'] as const;
export type TaskResumeErrorType = typeof TASK_RESUME_ERROR_TYPES[number];
export function getTaskResumeErrorType(error: unknown): TaskResumeErrorType {
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof RangeError) return 'range_error';
  if (error instanceof SyntaxError) return 'syntax_error';
  return error instanceof Error ? 'error' : 'non_error';
}
