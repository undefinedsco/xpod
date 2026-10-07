import { types } from 'node:util';

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

export const TASK_RESUME_FAILURE_NAMES = ['Error', 'TypeError', 'RangeError', 'SyntaxError',
  'ReferenceError', 'EvalError', 'URIError', 'AggregateError'] as const;
export const TASK_RESUME_FAILURE_CODES = ['ENOSPC', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENOTFOUND', 'EACCES', 'ERR_INVALID_URL'] as const;
export const TASK_RESUME_SITE_MODULES = [
  'api/runs/RunStateCenter', 'api/runs/InngestRunExecutionBackend', 'api/runs/ConditionalResourceDocument',
  'api/runs/RunApproval', 'api/runs/RunCancellation', 'api/runs/ManagedRunWorker', 'api/runs/store',
  'api/chatkit/pod-store', 'api/tasks/TaskMaterializer', 'api/tasks/TaskService', 'api/handlers/TaskHandler',
] as const;
export interface TaskResumeFailure {
  name: typeof TASK_RESUME_FAILURE_NAMES[number];
  code?: typeof TASK_RESUME_FAILURE_CODES[number];
  causeCode?: typeof TASK_RESUME_FAILURE_CODES[number];
  site?: {
    module: typeof TASK_RESUME_SITE_MODULES[number];
    line: number;
    column: number;
    coordinate: 'compiled_js' | 'source_ts';
    kind: 'first_project_frame';
  };
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function allowed<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.some(entry => entry === value);
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** The same strict schema is used for HTTP evidence; unknown fields are never copied. */
export function selectTaskResumeFailure(value: unknown): TaskResumeFailure | undefined {
  try {
    if (!record(value) || Object.keys(value).some(key => !['name', 'code', 'causeCode', 'site'].includes(key))) return undefined;
    const name = ownValue(value, 'name');
    if (!allowed(name, TASK_RESUME_FAILURE_NAMES)) return undefined;
    const result: TaskResumeFailure = { name };
    for (const key of ['code', 'causeCode'] as const) {
      const code = ownValue(value, key);
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        if (!allowed(code, TASK_RESUME_FAILURE_CODES)) return undefined;
        result[key] = code;
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, 'site')) {
      const site = ownValue(value, 'site');
      if (!record(site) || Object.keys(site).some(key => !['module', 'line', 'column', 'coordinate', 'kind'].includes(key))) return undefined;
      const module = ownValue(site, 'module');
      const line = ownValue(site, 'line');
      const column = ownValue(site, 'column');
      const location = ownValue(site, 'coordinate');
      if (!allowed(module, TASK_RESUME_SITE_MODULES) || !coordinate(line) || !coordinate(column)
        || !allowed(location, ['compiled_js', 'source_ts'] as const) || ownValue(site, 'kind') !== 'first_project_frame') return undefined;
      result.site = { module, line, column, coordinate: location, kind: 'first_project_frame' };
    }
    return result;
  } catch { return undefined; }
}

/** Attribution only: a whitelisted project frame may be a caller of an external origin. */
export function getTaskResumeFailure(error: unknown): TaskResumeFailure | undefined {
  try {
    if (!types.isNativeError(error)) return undefined;
    const native = error as Error;
    const name: TaskResumeFailure['name'] = native instanceof TypeError ? 'TypeError'
      : native instanceof RangeError ? 'RangeError' : native instanceof SyntaxError ? 'SyntaxError'
        : native instanceof ReferenceError ? 'ReferenceError' : native instanceof EvalError ? 'EvalError'
          : native instanceof URIError ? 'URIError' : native instanceof AggregateError ? 'AggregateError' : 'Error';
    const result: TaskResumeFailure = { name };
    const code = ownValue(native, 'code');
    if (allowed(code, TASK_RESUME_FAILURE_CODES)) result.code = code;
    const cause = ownValue(native, 'cause');
    const causeCode = types.isNativeError(cause) ? ownValue(cause as Error, 'code') : undefined;
    if (allowed(causeCode, TASK_RESUME_FAILURE_CODES)) result.causeCode = causeCode;
    for (const field of ['message', 'name']) {
      const descriptor = Object.getOwnPropertyDescriptor(native, field);
      if (descriptor && (!('value' in descriptor) || typeof descriptor.value !== 'string'
        || descriptor.value.length > 8192 || /[\r\n]/.test(descriptor.value))) return result;
    }
    const stack = ownValue(native, 'stack');
    if (typeof stack !== 'string' || stack.length > 8192) return result;
    // Ignore the message line; parse only bounded V8/Bun frame lines, never eval or user paths.
    for (const frame of stack.split('\n').slice(1, 17)) {
      const match = /^\s+at (?:async )?(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)* \()?((?:file:\/\/)?\/app\/(dist|src)\/(api\/[A-Za-z0-9/_-]+)\.(js|ts)):(\d{1,7}):(\d{1,7})\)?$/.exec(frame);
      if (frame.includes('(') !== frame.endsWith(')')) continue;
      if (!match || (match[2] === 'dist' ? match[4] !== 'js' : match[4] !== 'ts')) continue;
      const module = match[3];
      const line = Number(match[5]);
      const column = Number(match[6]);
      if (!allowed(module, TASK_RESUME_SITE_MODULES) || !coordinate(line) || !coordinate(column)) continue;
      result.site = { module, line, column, coordinate: match[2] === 'dist' ? 'compiled_js' : 'source_ts', kind: 'first_project_frame' };
      break;
    }
    return result;
  } catch { return undefined; }
}
