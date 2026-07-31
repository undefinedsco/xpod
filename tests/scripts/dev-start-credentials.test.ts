import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

async function createHarness(body: string): Promise<string> {
  const script = await readFile(path.join(root, 'scripts/dev-start.sh'), 'utf8');
  const librarySource = script.split('# 主逻辑')[0];
  const dir = await mkdtemp(path.join(tmpdir(), 'xpod-dev-start-'));
  const harness = path.join(dir, 'harness.sh');
  await writeFile(harness, `${librarySource}\n${body}`, 'utf8');
  return harness;
}

async function runHarness(body: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const harness = await createHarness(body);
  try {
    const result = await execFileAsync('bash', [harness], {
      cwd: root,
      timeout: 8_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const typed = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: typed.stdout ?? '',
      stderr: typed.stderr ?? '',
      code: typed.code ?? 1,
    };
  }
}

describe('dev-start client credentials bootstrap', () => {
  it('fails closed when password login does not return an authorization token', async () => {
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
CSS_BASE="http://localhost:6300"
curl() {
  printf '{"name":"ForbiddenHttpError","message":"Invalid email/password combination."}\nHTTP_STATUS:403\n'
}
if init_credentials; then
  echo "unexpected-success"
  exit 7
fi
cat "$ENV_FILE"
`);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('unexpected-success');
    expect(result.stdout).toContain('Client Credentials 初始化失败');
    expect(result.stdout).not.toContain('使用 /dev/setup 替代');
    expect(result.stdout).not.toContain('XPOD_CLIENT_ID=');
    expect(result.stdout).not.toContain('XPOD_CLIENT_SECRET=');
  });

  it('uses account controls and CSS account token to create credentials without printing the secret', async () => {
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
CSS_BASE="http://localhost:6300"
CURL_LOG="$(mktemp)"
curl() {
  local args="$*"
  printf '%s\n' "$args" >> "$CURL_LOG"
  if [[ "$args" == *".account/login/password/"* ]]; then
    printf '{"authorization":"acct-token"}\nHTTP_STATUS:200\n'
    return 0
  fi
  if [[ "$args" == *".account/"* && "$args" != *"client-credentials"* ]]; then
    if [[ "$args" != *"Authorization: CSS-Account-Token acct-token"* ]]; then
      printf '{"error":"missing account token"}\nHTTP_STATUS:401\n'
      return 0
    fi
    printf '{"controls":{"account":{"clientCredentials":"http://localhost:6300/.account/account/abc/client-credentials/"}}}\nHTTP_STATUS:200\n'
    return 0
  fi
  if [[ "$args" == *".account/account/abc/client-credentials/"* ]]; then
    if [[ "$args" != *"Authorization: CSS-Account-Token acct-token"* ]]; then
      printf '{"error":"missing account token"}\nHTTP_STATUS:401\n'
      return 0
    fi
    printf '{"id":"client-id-1","secret":"secret-1"}\nHTTP_STATUS:201\n'
    return 0
  fi
  printf '{"error":"unexpected endpoint"}\nHTTP_STATUS:404\n'
}
init_credentials
printf '%s\n' '---ENV---'
cat "$ENV_FILE"
printf '%s\n' '---CALLS---'
cat "$CURL_LOG"
`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Client Credentials 已创建: client-id-1');
    expect(result.stdout.split('---ENV---')[0]).not.toContain('secret-1');
    expect(result.stdout).toContain('XPOD_CLIENT_ID=client-id-1');
    expect(result.stdout).toContain('XPOD_CLIENT_SECRET=secret-1');
    expect(result.stdout).toContain('.account/account/abc/client-credentials/');
    expect(result.stdout).toContain('Authorization: CSS-Account-Token acct-token');
  });
});
