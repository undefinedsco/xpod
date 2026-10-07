import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runScenario(scenario: 'create-timeout' | 'read-retry' | 'state-retry') {
  const root = path.resolve('.test-data/matrix-create-retry', randomUUID());
  roots.push(root);
  await mkdir(root, { recursive: true });
  const calls = path.join(root, 'calls.jsonl');
  const wrapper = path.join(root, 'fixture.ts');
  await writeFile(wrapper, `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const counts = new Map();
const scenario = ${JSON.stringify(scenario)};
globalThis.fetch = async (input, options = {}) => {
  const pathname = new URL(input).pathname;
  const method = options.method ?? 'GET';
  const key = method + ' ' + pathname;
  const attempt = (counts.get(key) ?? 0) + 1;
  counts.set(key, attempt);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method, pathname, attempt,
    bodyHash: options.body ? createHash('sha256').update(options.body).digest('hex') : undefined }) + '\\n');
  const timeout = () => { throw new DOMException('fixture timeout', 'TimeoutError'); };
  const json = (value, status = 200) => Response.json(value, { status });
  if (pathname.endsWith('/account/whoami')) {
    if (scenario === 'read-retry' && attempt === 1) timeout();
    return json({ user_id: 'https://pod.test/profile/card#me',
      'co.undefineds.webid': 'https://pod.test/profile/card#me', 'co.undefineds.pod_url': 'https://pod.test/' });
  }
  if (pathname.endsWith('/createRoom')) {
    if (scenario === 'create-timeout' && attempt === 1) timeout();
    if (scenario === 'state-retry') return json({ room_id: '!fixture:gateway.test' });
    return json({ errcode: 'M_UNKNOWN', error: 'fixture stop' }, 500);
  }
  if (method === 'PUT' && pathname.endsWith('/state/co.undefineds.agents')) {
    if (attempt === 1) timeout();
    return json({});
  }
  return json({ errcode: 'M_UNKNOWN', error: 'fixture stop' }, 500);
};
await import(${JSON.stringify(path.resolve('scripts/accept-matrix-collaboration.ts'))});
`);
  const result = await new Promise<{ code: string | number | null | undefined; stderr: string }>((resolve, reject) => {
    execFile('bun', ['--no-env-file', wrapper, '--url', 'https://gateway.test/', '--output', path.join(root, 'result.json')], {
      cwd: process.cwd(), env: { ...process.env, XPOD_MATRIX_TOKEN: 'matrix-test-credential' }, timeout: 10_000, maxBuffer: 64 * 1024,
    }, (error, _stdout, stderr) => {
      if (error?.killed) { reject(error); return; }
      resolve({ code: error?.code, stderr });
    });
  });
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Array<{
    method: string; pathname: string; attempt: number; bodyHash?: string;
  }>;
  return { ...result, calls: recorded };
}

describe('Matrix acceptance retry safety', () => {
  it('does not repeat a room creation with an unknown result', async () => {
    const result = await runScenario('create-timeout');
    expect(result.code).toBe(1);
    expect(result.calls.filter(call => call.pathname.endsWith('/createRoom'))).toHaveLength(1);
    expect(result.stderr).toContain('creation outcome is unknown and was not retried');
  });

  it('still retries an unanswered read', async () => {
    const result = await runScenario('read-retry');
    expect(result.code).toBe(1);
    expect(result.calls.filter(call => call.pathname.endsWith('/account/whoami'))).toHaveLength(2);
    expect(result.calls.filter(call => call.pathname.endsWith('/createRoom'))).toHaveLength(1);
  });

  it('still repeats the same idempotent state write', async () => {
    const result = await runScenario('state-retry');
    expect(result.code).toBe(1);
    const stateWrites = result.calls.filter(call => call.method === 'PUT');
    expect(stateWrites).toHaveLength(2);
    expect(stateWrites[0].bodyHash).toBe(stateWrites[1].bodyHash);
  });
});
