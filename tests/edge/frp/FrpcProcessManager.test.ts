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
