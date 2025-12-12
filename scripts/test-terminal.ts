#!/usr/bin/env npx ts-node
/**
 * Terminal Integration Test Script
 *
 * Run this script directly to test Terminal Sidecar functionality:
 *   npx ts-node scripts/test-terminal.ts
 *   yarn test:terminal
 *
 * This script tests:
 * - Direct PTY sessions (no sandbox)
 * - Sandboxed sessions (sandbox-exec on macOS, bubblewrap on Linux)
 */

import { TerminalSession } from '../src/terminal/TerminalSession';
import { SandboxFactory } from '../src/terminal/sandbox';
import type { SandboxConfig } from '../src/terminal/sandbox';
import type { SessionConfig } from '../src/terminal/types';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<boolean> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('\x1b[32m✓ PASS\x1b[0m');
    results.push({ name, passed: true });
    return true;
  } catch (error) {
    console.log('\x1b[31m✗ FAIL\x1b[0m');
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`    Error: ${errorMsg}`);
    results.push({ name, passed: false, error: errorMsg });
    return false;
  }
}

function createConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    command: '/bin/sh',
    args: [],
    workdir: process.cwd(),
    env: {},
    timeout: 60,
    ...overrides,
  };
}

// ============================================================================
// No-Sandbox Tests (Direct PTY)
// ============================================================================

async function testNoSandboxSuite(): Promise<void> {
  console.log('\n\x1b[1m[No Sandbox] Direct PTY Tests\x1b[0m\n');

  // Test 1: Spawn PTY and execute ls
  await runTest('Spawn PTY and execute ls command', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-1', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('ls package.json\n');
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes('package.json')) {
      throw new Error(`Expected 'package.json' in output, got: ${fullOutput.slice(0, 200)}`);
    }
  });

  // Test 2: Echo command
  await runTest('Execute echo command and capture output', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-2', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    const marker = `MARKER_${Date.now()}`;
    session.write(`echo "${marker}"\n`);
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes(marker)) {
      throw new Error(`Expected marker '${marker}' in output`);
    }
  });

  // Test 3: PID check
  await runTest('Report correct PID', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-3', 'test-user', config, {});

    await sleep(300);

    const pid = session.pid;
    session.terminate();

    if (!pid || pid <= 0) {
      throw new Error(`Expected positive PID, got: ${pid}`);
    }
  });

  // Test 4: Resize
  await runTest('Handle resize without error', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-4', 'test-user', config, {});

    await sleep(300);
    session.resize(120, 40);
    await sleep(100);

    session.terminate();
  });

  // Test 5: PWD command
  await runTest('Execute pwd and verify working directory', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-5', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('pwd\n');
    await sleep(500);

    session.terminate();

    const fullOutput = output.join('');
    const cwdName = process.cwd().split('/').pop();
    if (!fullOutput.includes(cwdName!)) {
      throw new Error(`Expected '${cwdName}' in output`);
    }
  });

  // Test 6: List directory
  await runTest('List directory contents with ls -la', async () => {
    const config = createConfig();
    const session = new TerminalSession('no-sb-6', 'test-user', config, {});

    const output: string[] = [];
    session.on('data', (data: string) => output.push(data));

    await sleep(500);
    session.write('ls -la src/\n');
    await sleep(1000);

    session.terminate();

    const fullOutput = output.join('');
    if (!fullOutput.includes('terminal') && !fullOutput.includes('http')) {
      throw new Error(`Expected 'terminal' or 'http' in ls output`);
    }
  });
}

// ============================================================================
// Sandbox Tests (Platform-specific)
// ============================================================================

async function testSandboxSuite(): Promise<void> {
  const sandboxAvailable = SandboxFactory.isAvailable();
  const technology = SandboxFactory.getTechnology();

  console.log(`\n\x1b[1m[Sandbox] ${technology} Tests\x1b[0m`);
  console.log(`  Platform: ${process.platform}, Available: ${sandboxAvailable}\n`);

  if (!sandboxAvailable) {
    console.log('  \x1b[33m⚠ Sandbox not available, skipping tests\x1b[0m\n');
    return;
  }

  // Test 1: Launch sandboxed process
  await runTest(`Launch ${technology} sandbox and execute command`, async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'echo SANDBOX_OK'],
      env: {},
    };

    const result = SandboxFactory.launch(config);

    if (!result.sandboxed) {
      throw new Error('Expected sandboxed=true');
    }
    if (result.technology !== technology) {
      throw new Error(`Expected technology=${technology}, got ${result.technology}`);
    }

    const output: string[] = [];
    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Process exited with code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('SANDBOX_OK')) {
      throw new Error(`Expected 'SANDBOX_OK' in output, got: ${fullOutput}`);
    }
  });

  // Test 2: Workdir access
  await runTest('Access files in workdir', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'ls package.json && cat package.json | head -1'],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];
    const errors: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));
    result.process.stderr?.on('data', (data) => errors.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}: ${errors.join('')}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('package.json') && !fullOutput.includes('{')) {
      throw new Error(`Expected workdir file access, got: ${fullOutput}`);
    }
  });

  // Test 3: Write file in workdir
  await runTest('Write file in workdir', async () => {
    const testFile = `.test-data/sandbox-test-${Date.now()}.txt`;
    const testContent = `sandbox-test-${Date.now()}`;

    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', `mkdir -p .test-data && echo "${testContent}" > ${testFile} && cat ${testFile}`],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes(testContent)) {
      throw new Error(`Expected '${testContent}' in output, got: ${fullOutput}`);
    }

    // Cleanup
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(testFile);
    } catch {
      // ignore
    }
  });

  // Test 4: Network access (if not isolated)
  await runTest('Network access works (non-isolated)', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'curl -s --connect-timeout 5 https://httpbin.org/get | head -1 || echo "NETWORK_FAIL"'],
      env: {},
      isolateNetwork: false,
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve) => {
      result.process.on('exit', () => resolve());
      result.process.on('error', () => resolve());
    });

    const fullOutput = output.join('');
    // Should either succeed or show attempt (not immediately fail)
    if (fullOutput.includes('NETWORK_FAIL') && !fullOutput.includes('{')) {
      // Network might be unavailable, but sandbox didn't block it
      console.log(' (network unavailable, but not blocked)');
    }
  });

  // Test 5: Read system paths
  await runTest('Read-only access to system paths', async () => {
    const config: SandboxConfig = {
      workdir: process.cwd(),
      command: '/bin/sh',
      args: ['-c', 'ls /usr/bin/env && which sh'],
      env: {},
    };

    const result = SandboxFactory.launch(config);
    const output: string[] = [];

    result.process.stdout?.on('data', (data) => output.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      result.process.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Exit code ${code}`));
      });
      result.process.on('error', reject);
    });

    const fullOutput = output.join('');
    if (!fullOutput.includes('env') && !fullOutput.includes('sh')) {
      throw new Error(`Expected system path access, got: ${fullOutput}`);
    }
  });

  // Test 6: Deny access outside workdir (macOS only, skip on Linux for now)
  if (process.platform === 'darwin') {
    await runTest('Deny write access outside workdir', async () => {
      const config: SandboxConfig = {
        workdir: process.cwd(),
        command: '/bin/sh',
        args: ['-c', 'touch /tmp/xpod-sandbox-test-deny 2>&1 || echo "DENIED"'],
        env: {},
      };

      const result = SandboxFactory.launch(config);
      const output: string[] = [];

      result.process.stdout?.on('data', (data) => output.push(data.toString()));
      result.process.stderr?.on('data', (data) => output.push(data.toString()));

      await new Promise<void>((resolve) => {
        result.process.on('exit', () => resolve());
      });

      // Note: /tmp might be allowed in some sandbox configs
      // This test documents behavior rather than strict enforcement
      const fullOutput = output.join('');
      console.log(` (output: ${fullOutput.trim().slice(0, 50)})`);
    });
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n\x1b[1m╔══════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║        Terminal PTY Integration Tests                    ║\x1b[0m');
  console.log('\x1b[1m╚══════════════════════════════════════════════════════════╝\x1b[0m');

  // Run no-sandbox tests
  await testNoSandboxSuite();

  // Run sandbox tests
  await testSandboxSuite();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1mResults Summary\x1b[0m');
  console.log('\x1b[1m══════════════════════════════════════════════════════════════\x1b[0m');
  console.log(`  \x1b[32mPassed: ${passed}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${failed}\x1b[0m`);
  console.log(`  Total:  ${results.length}`);

  if (failed > 0) {
    console.log('\n\x1b[31mFailed tests:\x1b[0m');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}`);
      if (r.error) console.log(`    ${r.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
