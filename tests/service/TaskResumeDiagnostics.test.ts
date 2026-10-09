import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { withTaskResumeStage, getTaskResumeStage, getTaskResumeErrorType, getTaskResumeFailure, selectTaskResumeFailure } from '../../src/api/tasks/TaskResumeDiagnostics';
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

function withStack<T extends Error>(error: T, stack: string): T {
  Object.defineProperty(error, 'stack', { value: stack, writable: true, configurable: true });
  return error;
}
const site = { module: 'api/runs/RunStateCenter', line: 461, column: 15,
  coordinate: 'compiled_js', kind: 'first_project_frame' };
describe('bounded resume failure attribution', () => {
  it('projects the original frozen Error without invoking getters or exposing text', async () => {
    const cause = Object.assign(new Error('private-cause'), { code: 'ECONNREFUSED' });
    const error = Object.freeze(Object.assign(withStack(new TypeError('private-message'),
      'TypeError: private-message\n    at complete (/app/dist/api/runs/RunStateCenter.js:461:15)'), { code: 'ECONNRESET', cause, name: 'private-name' }));
    await expect(withTaskResumeStage('continuation_complete', async () => { throw error; })).rejects.toBe(error);
    expect(getTaskResumeFailure(error)).toEqual({ name: 'TypeError', code: 'ECONNRESET', causeCode: 'ECONNREFUSED', site });
    expect(getTaskResumeStage(error)).toBe('continuation_complete');
    expect(JSON.stringify(getTaskResumeFailure(error))).not.toContain('private');
  });
  it('accepts a fixed async frame prefix without exposing the function', () => {
    expect(getTaskResumeFailure(withStack(new Error('private'), 'Error: private\n    at async RunStateCenter.completePreparedClientToolOutput (/app/dist/api/runs/RunStateCenter.js:461:15)'))).toEqual({ name: 'Error', site });
  });
  it.each([
    ['/app/src/api/runs/store.ts', 'source_ts', 'api/runs/store'],
    ['file:///app/dist/api/chatkit/pod-store.js', 'compiled_js', 'api/chatkit/pod-store'],
  ])('accepts an exact deployed or source-map module %s', (path, coordinate, module) => {
    const error = withStack(new Error('private'), `Error: private\n    at f (${path}:8:2)`);
    expect(getTaskResumeFailure(error)).toEqual({ name: 'Error', site: { ...site, module, line: 8, column: 2, coordinate } });
  });
  it.each(['/Users/private/RunStateCenter.ts', '/app/dist/api/runs/../runs/RunStateCenter.js',
    '/app/dist/api/runs/unknown.js', 'https://private/app/dist/api/runs/RunStateCenter.js',
    'file://private/app/dist/api/runs/RunStateCenter.js', '/app/dist/api/runs/RunStateCenter.js?secret',
    '/app/dist/api/runs/%52unStateCenter.js', '/app/node_modules/private.js',
    '/app/dist/api/runs/RunStateCenter.js#secret'])('rejects an untrusted frame %s', path => {
    expect(getTaskResumeFailure(withStack(new Error('private'), `Error: private\n    at f (${path}:8:2)`))).toEqual({ name: 'Error' });
  });
  it('does not attribute a legitimate-looking frame embedded in multiline error prose', () => {
    const error = new Error('private\n    at forged (/app/dist/api/runs/store.js:1:2)');
    expect(getTaskResumeFailure(error)).toEqual({ name: 'Error' });
    const forgedName = withStack(new Error('private'), 'Error: private\n    at forged (/app/dist/api/runs/store.js:1:2)');
    Object.defineProperty(forgedName, 'name', { value: 'Error\n    at forged' });
    expect(getTaskResumeFailure(forgedName)).toEqual({ name: 'Error' });
  });
  it('ignores accessors, forged properties, oversized stacks and non-Errors', () => {
    const getter = () => { throw new Error('private-getter'); };
    const error = new Error('private');
    for (const key of ['stack', 'code', 'cause']) Object.defineProperty(error, key, { get: getter });
    expect(getTaskResumeFailure(error)).toEqual({ name: 'Error' });
    expect(getTaskResumeFailure({ name: 'Error', stack: 'private' })).toBeUndefined();
    expect(getTaskResumeFailure(withStack(new Error('private'), 'x'.repeat(8193)))).toEqual({ name: 'Error' });
    const inherited = Object.create(new Error('private'));
    expect(getTaskResumeFailure(inherited)).toBeUndefined();
  });
  it('reads only own fixed data fields and never follows cause cycles or forged schema', () => {
    const error = withStack(new Error('private'), 'Error: private\n    at /app/dist/api/runs/store.js:9:3');
    Object.assign(error, { cause: error, taskResumeFailure: { name: 'private' } });
    expect(getTaskResumeFailure(error)).toEqual({ name: 'Error', site: { ...site, module: 'api/runs/store', line: 9, column: 3 } });
    const getter = () => { throw new Error('private-getter'); };
    expect(selectTaskResumeFailure(Object.defineProperty({}, 'name', { get: getter }))).toBeUndefined();
    expect(selectTaskResumeFailure({ name: 'Error', site: Object.defineProperty({}, 'module', { get: getter }) })).toBeUndefined();
    expect(selectTaskResumeFailure(Object.create({ name: 'Error' }))).toBeUndefined();
    expect(selectTaskResumeFailure({ name: 'Error', message: 'private' })).toBeUndefined();
  });
  it('parses a native Bun stack format after only deployment-root substitution', () => {
    const script = `import { getTaskResumeFailure } from './src/api/tasks/TaskResumeDiagnostics';
async function nativeProbe() { await Promise.resolve(); throw new Error('private-message'); }
const error = await nativeProbe().catch(error => error);
const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
const stack = typeof descriptor?.value === 'string' ? descriptor.value : '';
const rewritten = stack.replaceAll(process.cwd() + '/[eval]', '/app/dist/api/runs/RunStateCenter.js');
Object.defineProperty(error, 'stack', { value: rewritten });
process.stdout.write(JSON.stringify({ nativeOwnValue: typeof descriptor?.value === 'string', failure: getTaskResumeFailure(error) }));`;
    const value = JSON.parse(execFileSync('bun', ['--no-env-file', '-e', script], { encoding: 'utf8', stdio: 'pipe' }));
    expect(value.nativeOwnValue).toBe(true);
    expect(value.failure).toMatchObject({ name: 'Error', site: { module: 'api/runs/RunStateCenter', coordinate: 'compiled_js', kind: 'first_project_frame' } });
    expect(JSON.stringify(value)).not.toContain('private');
  });
});
