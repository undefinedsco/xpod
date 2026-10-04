import { describe, expect, it } from 'vitest';
import { withTaskResumeStage, getTaskResumeStage, getTaskResumeErrorType } from '../../src/api/tasks/TaskResumeDiagnostics';
describe('Task resume diagnostic identity', () => {
  it('preserves frozen errors and the first inner boundary without trusting forged fields', async () => {
    const error = Object.freeze(Object.assign(new Error('original'), { taskResumeStage: 'secret', cause: new Error('cause') }));
    expect(getTaskResumeStage(error)).toBeUndefined();
    await expect(withTaskResumeStage('route_request', () => withTaskResumeStage('task_auth_restore', async () => { throw error; }))).rejects.toBe(error);
    expect(getTaskResumeStage(error)).toBe('task_auth_restore');
    expect(error.message).toBe('original');
    expect(error.cause.message).toBe('cause');
  });
  it.each([[new Error('same'), 'error'], [Object.freeze(new TypeError('same')), 'type_error'], [new RangeError('same'), 'range_error'], [new SyntaxError('same'), 'syntax_error'], ['same', 'non_error'], [Object.assign(new Error('same'), { name: 'TypeError' }), 'error']] as const)('classifies built-in identity only', (error, expected) => {
    expect(getTaskResumeErrorType(error)).toBe(expected);
  });
  it('does not register an unknown runtime stage', async () => {
    const error = new Error('same');
    await expect(withTaskResumeStage('forged' as never, async () => { throw error; })).rejects.toBe(error);
    expect(getTaskResumeStage(error)).toBeUndefined();
  });
  it('leaves primitive rejection untouched and unclassified', async () => {
    await expect(withTaskResumeStage('run_read', async () => { throw 'primitive'; })).rejects.toBe('primitive');
    expect(getTaskResumeStage('primitive')).toBeUndefined();
    expect(getTaskResumeStage({ taskResumeStage: 'run_read' })).toBeUndefined();
  });
});
