import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const integration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';

function matrixFixtureFailure(error: ExecFileException, stdout: string, stderr: string): string {
  const code = typeof error.code === 'number' && Number.isInteger(error.code)
    ? error.code
    : ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT', 'EACCES'].includes(String(error.code))
      ? error.code
      : 'unknown';
  const signal = error.signal == null
    ? null
    : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(error.signal)
      ? error.signal
      : 'unknown';
  return `Matrix fixture failed: ${JSON.stringify({
    code, signal, killed: error.killed === true,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'), stderrBytes: Buffer.byteLength(stderr, 'utf8'),
  })}`;
}

describe.skipIf(!integration)('Matrix authenticated Pod collaboration', () => {
  it('roundtrips two runtimes and a paginated backlog through its authenticated Gateway', async () => {
    const evidenceRoot = path.resolve('.test-data/matrix-collaboration-evidence', randomUUID());
    const output = path.join(evidenceRoot, 'result.json');
    await mkdir(evidenceRoot, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('bun', ['--no-env-file', path.resolve('tests/helpers/runMatrixCollaborationAcceptance.ts'), '--output', output], {
          cwd: process.cwd(), env: process.env, timeout: 960_000, maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error) { reject(new Error(matrixFixtureFailure(error, stdout, stderr))); return; }
          resolve();
        });
      });
      const evidence = JSON.parse(await readFile(output, 'utf8'));
      expect(evidence).toMatchObject({ status: 'passed', mode: 'deterministic-runtime', expectedEvents: 63, observedEvents: 63 });
      expect(evidence.results).toHaveLength(2);
      expect(evidence.syncPages).toBeGreaterThan(1);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }, 990_000);
});
