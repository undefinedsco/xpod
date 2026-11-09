import type { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { assertCompleteDigest, collectChildStdout } from './collectChildStdout';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
  return { child, promise: collectChildStdout(child as unknown as ChildProcess) };
}

describe('already-spawned child stdout collection', () => {
  it('waits through exit for the final stdout chunk and close', async () => {
    const { child, promise } = fixture();
    const settled = vi.fn();
    void promise.then(settled);
    child.stdout.write('a'.repeat(24));
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stdout.end('b'.repeat(40));
    await once(child.stdout, 'end');
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe('a'.repeat(24) + 'b'.repeat(40));
  });
  it('waits when exit occurs before any stdout', async () => {
    const { child, promise } = fixture();
    const settled = vi.fn();
    void promise.then(settled);
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.stdout.end('complete');
    await once(child.stdout, 'end');
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe('complete');
  });
  it.each([
    ['nonzero', 1, null], ['signal', null, 'SIGTERM'], ['zero-with-signal', 0, 'SIGTERM'], ['missing-code', null, null],
  ])('rejects %s termination', async (_label, code, signal) => {
    const { child, promise } = fixture();
    const rejected = expect(promise).rejects.toThrow('Child closed unsuccessfully');
    child.stdout.end('partial');
    await once(child.stdout, 'end');
    child.emit('close', code, signal);
    await rejected;
  });
  it.each(['process', 'stdout'])('rejects and sanitizes repeated %s errors', async (target) => {
    const { child, promise } = fixture();
    const rejected = expect(promise).rejects.toThrow(target === 'process' ? 'Child process failed' : 'Child stdout failed');
    const emitter = target === 'process' ? child : child.stdout;
    emitter.emit('error', new Error('private synthetic payload'));
    emitter.emit('error', new Error('private synthetic payload'));
    child.emit('close', 0, null);
    await rejected;
  });
  it('settles only once when close and error events repeat', async () => {
    const { child, promise } = fixture();
    const settled = vi.fn();
    void promise.then(settled);
    child.stdout.end('complete');
    await once(child.stdout, 'end');
    child.emit('close', 0, null);
    child.emit('close', 1, null);
    child.emit('error', new Error('private synthetic payload'));
    child.stdout.emit('error', new Error('private synthetic payload'));
    await expect(promise).resolves.toBe('complete');
    expect(settled).toHaveBeenCalledTimes(1);
  });
  it('preserves bytes across multibyte chunk boundaries without trimming', async () => {
    const { child, promise } = fixture();
    const bytes = Buffer.from('é\n');
    child.stdout.write(bytes.subarray(0, 1));
    child.stdout.end(bytes.subarray(1));
    await once(child.stdout, 'end');
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe('é\n');
  });
  it('rejects missing piped stdout', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: null });
    await expect(collectChildStdout(child as unknown as ChildProcess)).rejects.toThrow('Child stdout is not piped');
  });
});

describe('child digest output protocol', () => {
  it.each(['', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65), 'a'.repeat(64) + '\n'])('rejects malformed output case %#', (digest) => {
    expect(() => assertCompleteDigest(digest)).toThrow('Child digest output must be exactly 64 lowercase hex characters');
  });
  it('accepts every complete digest while retaining different values', () => {
    const digests = ['a'.repeat(64), 'b'.repeat(64)];
    digests.forEach(assertCompleteDigest);
    expect(new Set(digests).size).toBe(2);
  });
});
