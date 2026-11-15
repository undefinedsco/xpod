import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = join(import.meta.dir, '..', '..');

function findPython(): string | null {
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

describe('api capture timing diagnostic', () => {
  it('preserves the original exception and the fixed eight-event contract', () => {
    const script = join(import.meta.dir, 'helpers', 'api-capture-timing-diagnostic.py');
    expect(existsSync(script)).toBe(true);

    const python = findPython();
    expect(python).not.toBeNull();

    const result = spawnSync(python as string, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `timing diagnostic failed (status ${result.status})\n` +
          `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
      );
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('all timing diagnostic checks passed');
  }, 60_000);
});
