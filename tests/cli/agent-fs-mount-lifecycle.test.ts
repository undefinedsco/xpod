import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ helper: '', proxyScript: '', writeFailure: false, children: [] as ChildProcess[], closes: new WeakMap<ChildProcess, Promise<void>>() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    fixture.closes.set(child, new Promise<void>((resolve) => child.once('close', () => resolve())));
    vi.spyOn(child, 'kill');
    fixture.children.push(child);
    return child;
  }) };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (fixture.writeFailure && String(args[0]).endsWith('proxy.json')) {
      throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    }
    return fs.writeFileSync(...args);
  } };
});
vi.mock('../../packages/xpod-afs/src/agent-fs/mount', () => ({
  defaultBackend: () => 'nfs',
  describePrerequisites: () => ({ blockers: [], helperPresent: true, helperPath: fixture.helper }),
  MountUnavailableError: class extends Error {},
}));
vi.mock('../../packages/xpod-afs/src/runtime', () => ({ moduleRoot: () => process.cwd(), moduleLauncher: () => [ process.execPath, fixture.proxyScript ] }));
vi.mock('../../src/cli/lib/auth-context', () => ({ authFetch: vi.fn(), requireAuthContext: vi.fn() }));
vi.mock('../../packages/xpod-afs/src/directory/client', () => ({ AgentDirectoryClient: class {} }));

import { agentFsCommand } from '../../packages/xpod-afs/src/commands';

function commandHandler(name: string = 'mount'): (args: Record<string, unknown>) => Promise<void> {
  let handler: ((args: Record<string, unknown>) => Promise<void>) | undefined;
  const builder = {
    command(command: { command: string; handler: typeof handler }) {
      if (command.command === name) { handler = command.handler; }
      return builder;
    },
    demandCommand: () => builder,
    help: () => builder,
  };
  (agentFsCommand.builder as Function)(builder);
  if (!handler) { throw new Error('mount handler was not registered'); }
  return handler;
}

async function closeOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); }
  await fixture.closes.get(child);
}

describe('agent-fs actual mount child lifecycle', () => {
  let directory: string;
  let children: ChildProcess[];
  let previousExit: typeof process.exitCode;

  beforeEach(() => {
    previousExit = process.exitCode;
    process.exitCode = undefined;
    fixture.writeFailure = false;
    mkdirSync('.test-data/agent-fs-mount-lifecycle', { recursive: true, mode: 0o700 });
    directory = mkdtempSync(path.resolve('.test-data/agent-fs-mount-lifecycle/run-'));
    chmodSync(directory, 0o700);
    fixture.helper = path.join(directory, 'helper.sh');
    fixture.proxyScript = path.join(directory, 'proxy.cjs');
    writeFileSync(fixture.proxyScript, `process.stdout.write(JSON.stringify({origin:'http://127.0.0.1:12345',capability:'${'0'.repeat(64)}',identity:'fixture'})+'\\n'); setInterval(()=>{},1000);`, { mode: 0o600 });
    children = fixture.children = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const child of children) { await closeOwned(child); }
    process.stdout.write(`${JSON.stringify({ kind: 'owned-agentfs-fixture-close', children: children.map((child) => ({ pid: child.pid, actualExit: child.exitCode, actualSignal: child.signalCode, closeObserved: true })) })}\n`);
    process.exitCode = previousExit;
    fixture.writeFailure = false;
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  async function run(code: number, failedControl = false): Promise<void> {
    writeFileSync(fixture.helper, `#!/bin/sh\nexit ${code}\n`, { mode: 0o700 });
    fixture.writeFailure = failedControl;
    await commandHandler()({ 'pod-root': 'https://example.invalid/private-fixture/', 'session-dir': directory, json: true });
    expect(children).toHaveLength(2);
    expect(children[1].exitCode).toBe(code);
    expect(children[1].signalCode).toBeNull();
  }

  it('waits for actual helper ENOENT close before reporting failure and closes the owned proxy', async () => {
    fixture.helper = path.join(directory, 'absent-helper');
    await commandHandler()({ 'pod-root': 'https://example.invalid/private-fixture/', 'session-dir': directory, json: true });
    expect(children).toHaveLength(2);
    await fixture.closes.get(children[1]);
    expect(children[1].pid).toBeUndefined();
    expect(children[0].signalCode).toBe('SIGTERM');
    expect(process.exitCode).toBe(1);
  });

  it('cancels foreground startup before handshake and waits for actual proxy closure', async () => {
    writeFileSync(fixture.proxyScript, 'setInterval(()=>{},1000);', { mode: 0o600 });
    const pending = commandHandler()({ 'pod-root': 'https://example.invalid/private-fixture/', 'session-dir': directory, json: true });
    while (children.length === 0) { await new Promise(resolve => setTimeout(resolve, 5)); }
    // Unit signal dispatch; actual installed-process OS signal is a separate test.
    process.emit('SIGTERM'); await pending;
    expect(children).toHaveLength(1);
    expect(children[0].signalCode).toBe('SIGTERM');
    expect(process.exitCode).toBe(143);
    let absent = false;
    try { process.kill(-children[0].pid!, 0); } catch (cause) { absent = (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
    expect(absent).toBe(true);
  });

  it.each([ 75, 42 ])('ordinary unmount exit%s retains the existing actual proxy and control record', async (code) => {
    await run(75);
    const proxy = children[0];
    const before = readFileSync(path.join(directory, 'proxy.json'), 'utf8');
    writeFileSync(fixture.helper, `#!/bin/sh\nexit ${code}\n`, { mode: 0o700 });
    const fetch = vi.spyOn(globalThis, 'fetch');
    await commandHandler('unmount')({ 'session-dir': directory });
    expect(children).toHaveLength(3);
    expect(children[2].exitCode).toBe(code);
    expect(children[2].signalCode).toBeNull();
    expect(process.exitCode).toBe(code);
    expect(fetch).not.toHaveBeenCalled();
    expect(proxy.kill).not.toHaveBeenCalled();
    expect(proxy.exitCode).toBeNull();
    expect(proxy.signalCode).toBeNull();
    expect(readFileSync(path.join(directory, 'proxy.json'), 'utf8')).toBe(before);
  });

  it('pending exit75 is failure and retains detached auth proxy and control', async () => {
    await run(75);
    expect(process.exitCode).toBe(75);
    const envelope = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('mount_pending');
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(children[0].exitCode).toBeNull();
    expect(children[0].signalCode).toBeNull();
    expect(children[0].stdout?.destroyed).toBe(true);
    expect(JSON.parse(readFileSync(path.join(directory, 'proxy.json'), 'utf8')).capability).toHaveLength(64);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('12345');
  });

  it('ordinary helper failure closes only its owned proxy', async () => {
    await run(42);
    expect(process.exitCode).toBe(42);
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    await closeOwned(children[0]);
    expect(children[0].signalCode).toBe('SIGTERM');
  });

  it.each([ 75, 0 ])('injected control EACCES after helper exit%s retains proxy without hiding failure', async (code) => {
    await run(code, true);
    expect(process.exitCode).toBe(code === 75 ? 75 : 1);
    expect(children[0].kill).not.toHaveBeenCalled();
    expect(children[0].exitCode).toBeNull();
    expect(children[0].stdout?.destroyed).toBe(true);
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).toContain('EACCES');
    const envelope = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(envelope.ok).toBe(false);
    expect(output).not.toContain('12345');
    expect(output).not.toContain('private-fixture');
    expect(output).not.toContain('0'.repeat(64));
  });
});
