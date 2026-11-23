import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const shim = path.join(repoRoot, 'scripts/gh-retry-shim.sh');
const base = path.join(repoRoot, '.test-data/gh-retry-shim');
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A fake real `gh` that fails the first `failures` calls with `error`, then prints `ok`. */
function run(args: string[], failures: number, error = 'gh: Server Error (HTTP 502)') {
  const dir = mkdtempSync(path.join(base, 'case-'));
  const real = path.join(dir, 'gh-real');
  writeFileSync(real, `#!/usr/bin/env bash
count_file="${dir}/count"
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$count_file"
if [ "$count" -le ${failures} ]; then echo "partial-$count"; echo '${error}' >&2; exit 1; fi
echo ok
`);
  chmodSync(real, 0o755);
  const result = spawnSync('bash', [shim, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XPOD_REAL_GH: real, XPOD_GH_RETRY_DELAY_SECONDS: '0', XPOD_GH_RETRY_ATTEMPTS: '3', RUNNER_TEMP: dir },
  });
  const calls = Number(readFileSync(path.join(dir, 'count'), 'utf8'));
  return { ...result, calls };
}

describe('gh retry shim', () => {
  it('retries a read after a transient 5xx and emits only the successful output', () => {
    const result = run(['api', 'repos/o/r/actions/runs/1/jobs'], 2);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.calls).toBe(3);
    expect(result.stderr).toContain('retrying');
  });

  it.each([
    [['run', 'download', '1']],
    [['release', 'view', 'v1']],
    [['run', 'list', '--workflow', 'candidate.yml']],
  ])('retries read-only %j', args => {
    expect(run(args, 1).calls).toBe(2);
  });

  it.each([
    [['api', '-X', 'POST', 'repos/o/r/releases']],
    [['api', 'repos/o/r/dispatches', '-f', 'ref=main']],
    [['release', 'create', 'v1']],
    [['release', 'upload', 'v1', 'file']],
  ])('never retries a write %j', args => {
    const result = run(args, 1);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
  });

  it('returns a non-transient failure at once', () => {
    const result = run(['release', 'view', 'v9'], 1, 'release not found');
    expect(result.status).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.stderr).toContain('release not found');
  });

  it('reports the last failure once the attempts are used up', () => {
    const result = run(['api', 'repos/o/r'], 5);
    expect(result.status).toBe(1);
    expect(result.calls).toBe(3);
    expect(result.stdout).toBe('partial-3\n');
    expect(result.stderr).toContain('HTTP 502');
  });
});
