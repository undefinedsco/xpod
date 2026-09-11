import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const electronExecutable: string = createRequire(import.meta.url)('electron')
const fixtureRoot = fileURLToPath(new URL('../../.test-data/desktop-epipe/', import.meta.url))
const consoleModule = new URL('../dist/desktop-console.js', import.meta.url).href

async function runConsoleFixture(unsafe: boolean, closedStream?: 'stdout' | 'stderr', failingStream?: 'stdout' | 'stderr') {
  mkdirSync(fixtureRoot, { recursive: true })
  const directory = mkdtempSync(join(fixtureRoot, 'console-'))
  const readyPath = join(directory, 'ready')
  const ackPath = join(directory, 'ack')
  const errorPath = join(directory, 'error')
  const scriptPath = join(directory, 'fixture.mjs')
  writeFileSync(scriptPath, `
    import { Console } from 'node:console';
    import { writeFileSync } from 'node:fs';
    const logger = ${unsafe
      ? "new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false })"
      : `(await import(${JSON.stringify(consoleModule)})).desktopConsole`};
    // Observe the failure without suppressing Node's default fatal exception handling.
    process.on('uncaughtExceptionMonitor', (error) => {
      writeFileSync(${JSON.stringify(errorPath)}, error.code || error.message);
    });
    logger.info('stdout before disconnect');
    logger.warn('stderr before disconnect');
    writeFileSync(${JSON.stringify(readyPath)}, process.versions.electron);
    process.stdin.once('data', () => {
      ${failingStream ? `process.${failingStream}.emit('error', Object.assign(new Error('unrelated I/O failure'), { code: 'EIO' }));` : ''}
      logger.info('stdout after disconnect');
      logger.error('stderr after disconnect');
      // Stream errors may arrive asynchronously after console returns.
      setTimeout(() => {
        logger.log('stdout still alive');
        logger.warn('stderr still alive');
        setTimeout(() => {
          writeFileSync(${JSON.stringify(ackPath)}, 'alive');
          process.exit(0);
        }, 50);
      }, 50);
    });
  `)
  const child = spawn(electronExecutable, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => { stdout += data.toString() })
  child.stderr.on('data', (data) => { stderr += data.toString() })
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
  // Keep early spawn failures handled while waiting for the ready handshake.
  void completion.catch(() => undefined)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000)
  try {
    const deadline = Date.now() + 5_000
    while ((!existsSync(readyPath) || !readFileSync(readyPath, 'utf8')) && child.exitCode === null && Date.now() < deadline) {
      await delay(10)
    }
    expect(existsSync(readyPath)).toBe(true)
    expect(readFileSync(readyPath, 'utf8')).not.toBe('')
    if (closedStream) {
      const stream = child[closedStream]
      const closed = new Promise<void>((resolve) => stream.once('close', resolve))
      stream.destroy()
      await closed
    }
    child.stdin.end('write\n')
    const code = await completion
    return {
      code,
      stdout,
      stderr,
      acknowledged: existsSync(ackPath) && readFileSync(ackPath, 'utf8') === 'alive',
      errorCode: existsSync(errorPath) ? readFileSync(errorPath, 'utf8') : undefined,
    }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await completion.catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('desktop console with real Electron output pipes', () => {
  test('preserves output while both pipes are connected', async () => {
    const result = await runConsoleFixture(false)
    expect(result.code).toBe(0)
    expect(result.acknowledged).toBe(true)
    expect(result.errorCode).toBeUndefined()
    expect(result.stdout).toContain('stdout before disconnect')
    expect(result.stdout).toContain('stdout still alive')
    expect(result.stderr).toContain('stderr before disconnect')
    expect(result.stderr).toContain('stderr still alive')
  }, 10_000)

  for (const stream of ['stdout', 'stderr'] as const) {
    test(`survives repeated logs after the ${stream} reader disconnects`, async () => {
      const result = await runConsoleFixture(false, stream)
      expect(result.code).toBe(0)
      expect(result.acknowledged).toBe(true)
      expect(result.errorCode).toBeUndefined()
    }, 10_000)

    test(`does not suppress a non-EPIPE ${stream} error`, async () => {
      const result = await runConsoleFixture(false, undefined, stream)
      expect(result.code).not.toBe(0)
      expect(result.acknowledged).toBe(false)
      expect(result.errorCode).toBe('EIO')
    }, 10_000)

    test(`negative control: an unsafe console fails with EPIPE on disconnected ${stream}`, async () => {
      const result = await runConsoleFixture(true, stream)
      expect(result.code).not.toBe(0)
      expect(result.acknowledged).toBe(false)
      expect(result.errorCode).toBe('EPIPE')
    }, 10_000)
  }
})
