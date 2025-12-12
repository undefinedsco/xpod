/**
 * Terminal Session Integration Test
 *
 * This test spawns a real PTY session and executes actual commands.
 * Requires node-pty to be installed.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { TerminalSession } from '../../src/terminal/TerminalSession';
import type { SessionConfig } from '../../src/terminal/types';

describe('TerminalSession Integration', () => {
  let session: TerminalSession;

  const createConfig = (): SessionConfig => ({
    command: '/bin/sh',
    args: [],
    workdir: process.cwd(),
    env: {},
    timeout: 60, // 60 seconds
  });

  afterEach(() => {
    if (session) {
      session.terminate();
    }
  });

  it('should spawn a PTY and execute ls command', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-1', 'test-user', config, {});

    // Collect output
    const output: string[] = [];
    session.on('data', (data: string) => {
      output.push(data);
    });

    // Wait for shell to initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send ls command
    session.write('ls -la package.json\n');

    // Wait for command to execute
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check output contains package.json
    const fullOutput = output.join('');
    expect(fullOutput).toContain('package.json');
  });

  it('should execute echo command and capture output', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-2', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => {
      output.push(data);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Use echo with a unique marker
    const marker = `TEST_MARKER_${Date.now()}`;
    session.write(`echo "${marker}"\n`);

    await new Promise((resolve) => setTimeout(resolve, 500));

    const fullOutput = output.join('');
    expect(fullOutput).toContain(marker);
  });

  it('should handle resize', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-3', 'test-user', config, {});

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Should not throw
    expect(() => session.resize(120, 40)).not.toThrow();
  });

  it('should report correct pid', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-4', 'test-user', config, {});

    await new Promise((resolve) => setTimeout(resolve, 300));

    const pid = session.pid;
    expect(pid).toBeGreaterThan(0);
  });

  it('should handle pwd command', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-5', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => {
      output.push(data);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    session.write('pwd\n');

    await new Promise((resolve) => setTimeout(resolve, 500));

    const fullOutput = output.join('');
    // Should contain the current working directory
    expect(fullOutput).toContain(process.cwd().split('/').pop());
  });

  it('should list files in .test-data directory after creation', async () => {
    const config = createConfig();
    session = new TerminalSession('test-session-6', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => {
      output.push(data);
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Create .test-data dir and list it
    session.write('mkdir -p .test-data && ls -la .test-data\n');

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const fullOutput = output.join('');
    // Should show the directory listing (at least . and ..)
    expect(fullOutput).toMatch(/total|drwx/);
  });
});
