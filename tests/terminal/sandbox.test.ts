import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })),
  execSync: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    const existingPaths = ['/usr', '/lib', '/bin', '/etc/resolv.conf'];
    return existingPaths.includes(path);
  }),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock the logger
vi.mock('@solid/community-server', () => ({
  getLoggerFor: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SandboxFactory, BubblewrapSandbox, MacOSSandbox } from '../../src/terminal/sandbox';
import type { SandboxConfig } from '../../src/terminal/sandbox';
import { spawn, execSync } from 'child_process';

describe('Sandbox', () => {
  const defaultConfig: SandboxConfig = {
    workdir: '/home/user/workspace',
    command: '/bin/sh',
    args: [],
    env: { MY_VAR: 'test' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('BubblewrapSandbox', () => {
    it('should check bwrap availability', () => {
      const sandbox = new BubblewrapSandbox();
      
      (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/bwrap');
      
      // Reset cached value by creating new instance would be needed in real scenario
      expect(typeof sandbox.isAvailable()).toBe('boolean');
    });

    it('should build correct bwrap arguments', () => {
      const sandbox = new BubblewrapSandbox();
      
      // Mock bwrap available
      (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/bwrap');
      
      sandbox.launch(defaultConfig);
      
      expect(spawn).toHaveBeenCalled();
      const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe('bwrap');
      
      const args = call[1] as string[];
      // Should have namespace isolation
      expect(args).toContain('--unshare-pid');
      // Should bind workdir
      expect(args).toContain('--bind');
      expect(args).toContain('/home/user/workspace');
    });

    it('should add --unshare-net when isolateNetwork is true', () => {
      const sandbox = new BubblewrapSandbox();
      
      sandbox.launch({
        ...defaultConfig,
        isolateNetwork: true,
      });
      
      const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const args = call[1] as string[];
      expect(args).toContain('--unshare-net');
    });
  });

  describe('MacOSSandbox', () => {
    it('should check sandbox-exec availability', () => {
      const sandbox = new MacOSSandbox();
      
      // Mock darwin platform
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/sandbox-exec');
      
      expect(typeof sandbox.isAvailable()).toBe('boolean');
      
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should create sandbox profile and launch', () => {
      const sandbox = new MacOSSandbox();
      
      // Force available
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('/usr/bin/sandbox-exec');
      
      const result = sandbox.launch(defaultConfig);
      
      expect(spawn).toHaveBeenCalled();
      expect(result.technology).toBe('sandbox-exec');
    });
  });

  describe('SandboxFactory', () => {
    it('should return sandbox technology name', () => {
      const tech = SandboxFactory.getTechnology();
      expect(['bubblewrap', 'sandbox-exec', 'none']).toContain(tech);
    });

    it('should launch process', () => {
      const result = SandboxFactory.launch(defaultConfig);
      
      expect(result).toHaveProperty('process');
      expect(result).toHaveProperty('sandboxed');
      expect(result).toHaveProperty('technology');
    });

    it('should check availability', () => {
      expect(typeof SandboxFactory.isAvailable()).toBe('boolean');
    });
  });
});
