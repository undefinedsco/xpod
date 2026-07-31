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

async function runHarness(
  body: string,
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const harness = await createHarness(body);
  try {
    const result = await execFileAsync('bash', [harness], {
      cwd: root,
      env: { ...process.env, ...options.env },
      timeout: options.timeout ?? 8_000,
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
    expect(result.stdout).toContain("XPOD_CLIENT_ID='client-id-1'");
    expect(result.stdout).toContain("XPOD_CLIENT_SECRET='secret-1'");
    expect(result.stdout).toContain('.account/account/abc/client-credentials/');
    expect(result.stdout).toContain('Authorization: CSS-Account-Token acct-token');
  });

  it('shell-quotes generated env values so command substitutions never execute when sourced', async () => {
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
PWNED_FILE="$(mktemp)"
rm -f "$PWNED_FILE"
CSS_BASE="http://localhost:6300"
curl() {
  local args="$*"
  if [[ "$args" == *".account/login/password/"* ]]; then
    printf '{"authorization":"acct-token"}\nHTTP_STATUS:200\n'
    return 0
  fi
  if [[ "$args" == *".account/"* && "$args" != *"client-credentials"* ]]; then
    printf '{"controls":{"account":{"clientCredentials":"http://localhost:6300/.account/account/abc/client-credentials/"}}}\nHTTP_STATUS:200\n'
    return 0
  fi
  if [[ "$args" == *"client-credentials"* ]]; then
    local bt
    bt="$(printf '\140')"
    printf '{"id":"client-id-1","secret":"sec $(touch '"$PWNED_FILE"') %secho nope%s $HOME with space"}\nHTTP_STATUS:201\n' "$bt" "$bt"
    return 0
  fi
  printf '{"error":"unexpected endpoint"}\nHTTP_STATUS:404\n'
}
init_credentials
source "$ENV_FILE"
printf 'secret=%s\n' "$XPOD_CLIENT_SECRET"
if [ -e "$PWNED_FILE" ]; then
  echo "pwned"
  exit 9
fi
`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('secret=sec $(touch ');
    expect(result.stdout).toContain(') `echo nope` $HOME with space');
    expect(result.stdout).not.toContain('pwned');
  });

  it('rejects multiline generated env values instead of writing them', async () => {
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
if write_env_value XPOD_CLIENT_SECRET $'bad\nvalue' secret; then
  echo "unexpected-success"
  exit 7
fi
printf '%s\n' '---ENV---'
cat "$ENV_FILE"
`);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('unexpected-success');
    expect(result.stdout).toContain('非法环境变量值');
    expect(result.stdout.split('---ENV---')[1]).not.toContain('XPOD_CLIENT_SECRET');
  });

  it('rejects cross-origin clientCredentials controls before sending the account token', async () => {
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
    printf '{"controls":{"account":{"clientCredentials":"http://evil.test/.account/account/abc/client-credentials/"}}}\nHTTP_STATUS:200\n'
    return 0
  fi
  printf '{"id":"evil","secret":"stolen"}\nHTTP_STATUS:201\n'
}
if init_credentials; then
  echo "unexpected-success"
  exit 7
fi
printf '%s\n' '---CALLS---'
cat "$CURL_LOG"
`);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('unexpected-success');
    expect(result.stdout).toContain('clientCredentials endpoint 不可信');
    expect(result.stdout).not.toContain('evil.test/.account/account/abc/client-credentials/');
    expect(result.stdout).not.toContain('stolen');
  });

  it('keeps credential requests from following cross-origin redirects', async () => {
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
    printf '{"controls":{"account":{"clientCredentials":"http://localhost:6300/.account/account/abc/client-credentials/"}}}\nHTTP_STATUS:200\n'
    return 0
  fi
  if [[ "$args" == *"client-credentials"* ]]; then
    printf '{"location":"http://evil.test/capture"}\nHTTP_STATUS:302\n'
    return 0
  fi
  printf '{"error":"unexpected"}\nHTTP_STATUS:404\n'
}
if init_credentials; then
  echo "unexpected-success"
  exit 7
fi
printf '%s\n' '---CALLS---'
cat "$CURL_LOG"
`);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('unexpected-success');
    expect(result.stdout).toContain('创建失败');
    expect(result.stdout).toContain('--max-redirs 0');
    expect(result.stdout).not.toContain('evil.test/capture');
  });

  it('cleans up the cloud process when credential initialization fails', async () => {
    const cleanupLog = path.join(await mkdtemp(path.join(tmpdir(), 'xpod-cloud-cleanup-')), 'cleanup.log');
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
CSS_BASE="http://localhost:6300"
API_BASE="http://localhost:6301"
bun() {
  trap 'printf TERM > "$CLEANUP_LOG"; exit 0' TERM
  while :; do sleep 1; done
}
wait_for_service() { return 0; }
init_credentials() { return 1; }
create_test_node() { echo "unexpected-node"; return 0; }
start_cloud
`, { env: { CLEANUP_LOG: cleanupLog }, timeout: 8_000 });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('unexpected-node');
    expect(await readFile(cleanupLog, 'utf8')).toBe('TERM');
  });

  it('redacts all sensitive generated env values from successful cloud startup output', async () => {
    const result = await runHarness(String.raw`
ENV_FILE="$(mktemp)"
CSS_BASE="http://localhost:6300"
API_BASE="http://localhost:6301"
bun() { return 0; }
sleep() { return 0; }
wait_for_service() { return 0; }
init_credentials() {
  write_env_value XPOD_CLIENT_ID "client-id-visible" id
  write_env_value XPOD_CLIENT_SECRET "client-secret-sensitive" secret
}
create_test_node() {
  write_env_value XPOD_NODE_ID "node-id-visible" id
  write_env_value XPOD_NODE_TOKEN "node-token-sensitive" token
  write_env_value XPOD_SIGNALING_URL "http://localhost:6301/signal" url
  write_env_value xpOd_authToken "auth-token-sensitive" token
  write_env_value SERVICE_PASSWORD "password-sensitive" secret
  write_env_value OPENAI_API_KEY "api-key-sensitive" secret
}
start_cloud
`);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("XPOD_CLIENT_ID='client-id-visible'");
    expect(result.stdout).toContain("XPOD_NODE_ID='node-id-visible'");
    expect(result.stdout).toContain("XPOD_SIGNALING_URL='http://localhost:6301/signal'");
    expect(result.stdout).toContain('XPOD_CLIENT_SECRET=[redacted]');
    expect(result.stdout).toContain('XPOD_NODE_TOKEN=[redacted]');
    expect(result.stdout).toContain('xpOd_authToken=[redacted]');
    expect(result.stdout).toContain('SERVICE_PASSWORD=[redacted]');
    expect(result.stdout).toContain('OPENAI_API_KEY=[redacted]');
    expect(result.stdout).not.toContain('client-secret-sensitive');
    expect(result.stdout).not.toContain('node-token-sensitive');
    expect(result.stdout).not.toContain('auth-token-sensitive');
    expect(result.stdout).not.toContain('password-sensitive');
    expect(result.stdout).not.toContain('api-key-sensitive');
  });
});
