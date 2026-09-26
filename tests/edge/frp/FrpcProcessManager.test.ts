import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { FrpcProcessManager } from '../../../src/edge/frp/FrpcProcessManager';

class MockChildProcess extends EventEmitter {
  public stdout = new PassThrough();
  public stderr = new PassThrough();
  public pid = 1234;
  public killed = false;

  public kill(): void {
    this.killed = true;
    this.emit('exit', 0, null);
  }
}

describe('FrpcProcessManager', () => {
  it('tracks status across lifecycle', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frpc-test-'));
    const configPath = path.join(tmpDir, 'frpc.ini');
    const mockProcess = new MockChildProcess();
    const spawnStub = vi.fn().mockReturnValue(mockProcess);
    const manager = new FrpcProcessManager({
      binaryPath: '/usr/bin/frpc',
      configPath,
      processFactory: spawnStub as any,
      autoRestart: false,
    });

    await manager.applyConfig({
      serverHost: 'frp.example',
      proxyName: 'node-1',
      entrypoint: 'https://proxy.example/node-1',
    }, 'active', 'https://proxy.example/node-1');

    expect(spawnStub).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().state).toBe('running');
    expect(manager.getStatus().entrypoint).toBe('https://proxy.example/node-1');

    mockProcess.emit('exit', 1, null);
    expect(manager.getStatus().state).toBe('error');

    await manager.applyConfig(undefined, 'standby');
    expect(manager.getStatus().state).toBe('inactive');

    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

/**
 * N18: frpc retried every second forever and `stop()` did not cancel the scheduled retry, so a
 * stopped tunnel could be resurrected by its own timer. Restarts now back off exponentially, a
 * long-enough run clears the streak, and secrets land on disk as 0600.
 */
describe('FrpcProcessManager restart backoff (N18)', () => {
  async function makeManager(options: { autoRestart?: boolean } = {}) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frpc-backoff-'));
    const configPath = path.join(tmpDir, 'frpc.ini');
    const processes: MockChildProcess[] = [];
    const spawnStub = vi.fn(() => {
      const proc = new MockChildProcess();
      processes.push(proc);
      return proc;
    });
    const manager = new FrpcProcessManager({
      binaryPath: '/usr/bin/frpc',
      configPath,
      processFactory: spawnStub as any,
      autoRestart: options.autoRestart ?? true,
    });
    return { manager, spawnStub, processes, configPath, tmpDir };
  }

  it('backs off exponentially instead of retrying every second', async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawnStub, processes } = await makeManager();
      await manager.applyConfig({ serverHost: 'frp.example', token: 'secret-token' }, 'active');
      expect(spawnStub).toHaveBeenCalledTimes(1);

      processes[0].emit('exit', 1, null);
      expect(manager.getStatus().nextRestartInMs).toBe(1_000);
      expect(manager.getStatus().restartCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      // 重启路径里有真实的 fs I/O，等它落定再断言（假定时器只接管计时器）。
      await vi.waitFor(() => expect(spawnStub).toHaveBeenCalledTimes(2));
      processes[1].emit('exit', 1, null);
      expect(manager.getStatus().nextRestartInMs).toBe(2_000);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(spawnStub).toHaveBeenCalledTimes(3));
      processes[2].emit('exit', 1, null);
      expect(manager.getStatus().nextRestartInMs).toBe(4_000);

      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the streak after a run that lasted long enough', async () => {
    vi.useFakeTimers();
    try {
      const { manager, processes } = await makeManager();
      await manager.applyConfig({ serverHost: 'frp.example' }, 'active');

      // The process stays up past the healthy threshold before crashing.
      await vi.advanceTimersByTimeAsync(70_000);
      processes[0].emit('exit', 1, null);

      expect(manager.getStatus().restartCount).toBe(0);
      expect(manager.getStatus().nextRestartInMs).toBe(1_000);
      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect a stopped tunnel with a scheduled restart', async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawnStub, processes } = await makeManager();
      await manager.applyConfig({ serverHost: 'frp.example' }, 'active');
      processes[0].emit('exit', 1, null);
      expect(manager.getStatus().nextRestartInMs).toBe(1_000);

      await manager.stop();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(spawnStub).toHaveBeenCalledTimes(1);
      expect(manager.getStatus().state).toBe('inactive');
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the frpc config, token included, as 0600', async () => {
    const { manager, configPath, tmpDir } = await makeManager({ autoRestart: false });
    await manager.applyConfig({ serverHost: 'frp.example', token: 'secret-token' }, 'active');

    const contents = await fs.readFile(configPath, 'utf8');
    expect(contents).toContain('token = secret-token');
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);

    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
