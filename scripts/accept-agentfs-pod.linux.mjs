#!/usr/bin/env node
// Linux real-mount acceptance for the AgentFS Pod helper.
//
// Ownership/cleanup rules (mandated):
//   - Only removes the docker containers/network it created (names suffixed with
//     process.pid). It NEVER calls pkill and never touches other agents' mounts.
//   - Do not run concurrently with the implementation worker's full gate, because
//     scripts/run-vitest-safe.sh performs a repo-wide pkill.
//
// It mounts the Pod HTTP helper inside a Linux container against an EXTERNAL
// recording HTTP fixture (a separate container) and runs real file operations.
// The helper's in-process `selftest` fixture is NOT used as evidence.
//
// Knobs: XPOD_AGENTFS_LINUX_BIN, XPOD_AGENTFS_BUILD_LINUX=1, XPOD_AGENTFS_BACKEND=nfs|fuse
// XPOD_AGENTFS_LINUX_INSTALL optionally verifies the actual installed CLI lifecycle.
// Exit: 0 pass, 1 fail, 3 unavailable.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { ok: 0, fail: 1, unavailable: 3 };
const pid = process.pid;
const RUN = `agentfs-linux-${pid}`;
const NET = `${RUN}-net`;
const FIXTURE = `${RUN}-fixture`;
const HELPER = `${RUN}-helper`;
const BACKEND = process.env.XPOD_AGENTFS_BACKEND ?? 'fuse';
const WORK = path.join(REPO_ROOT, '.test-data', 'agent-directory-workers', 'agentfs-test', 'linux');
const REPORT = path.join(REPO_ROOT, '.test-data', 'agent-directory-workers', 'agentfs-linux-report.json');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
}

function cleanup() {
  docker([ 'rm', '-f', FIXTURE ], { timeoutMs: 30_000 });
  docker([ 'rm', '-f', HELPER ], { timeoutMs: 30_000 });
  docker([ 'network', 'rm', NET ], { timeoutMs: 30_000 });
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(EXIT.unavailable); });
process.on('SIGTERM', () => { cleanup(); process.exit(EXIT.unavailable); });

function writeReport(payload) {
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[agentfs-linux] wrote ${REPORT}`);
}

function unavailable(reason) {
  console.log(`STATUS: UNAVAILABLE - ${reason}`);
  writeReport({ status: 'unavailable', reason, backend: BACKEND, platform: process.platform });
  process.exit(EXIT.unavailable);
}

const info = docker([ 'info' ], { timeoutMs: 30_000 });
if (info.status !== 0) {
  unavailable(`docker server not reachable: ${info.stderr.trim().slice(0, 120)}`);
}
const version = docker([ 'version', '--format', '{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}' ], { timeoutMs: 30_000 });
console.log(`[agentfs-linux] docker ${version.stdout.trim()}`);

const fuse = docker([ 'run', '--rm', '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', 'alpine:3.22', 'sh', '-c', 'test -c /dev/fuse' ], { timeoutMs: 120_000 });
if (fuse.status !== 0) {
  console.log('[agentfs-linux] warning: /dev/fuse not visible to containers; only the NFS backend can be attempted');
}

let linuxBin = process.env.XPOD_AGENTFS_LINUX_BIN ?? '';
const linuxInstall = process.env.XPOD_AGENTFS_LINUX_INSTALL ? path.resolve(process.env.XPOD_AGENTFS_LINUX_INSTALL) : undefined;
if (linuxInstall) {
  linuxBin = path.join(linuxInstall, 'helper', 'agentfs-pod');
  if (!existsSync(path.join(linuxInstall, 'bin', 'xpodcli'))) {
    unavailable('installed Linux CLI is missing');
  }
}
mkdirSync(WORK, { recursive: true });
if (!linuxBin && process.env.XPOD_AGENTFS_BUILD_LINUX === '1') {
  console.log('[agentfs-linux] building linux helper with an isolated CARGO_TARGET_DIR');
  const build = spawnSync('bash', [ path.join(REPO_ROOT, 'tools/agentfs-pod/build-linux.sh') ], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(path.join(WORK, 'build.log'), `${build.stdout}\n${build.stderr}\n`, 'utf8');
  if (build.status === 0) {
    linuxBin = path.join(REPO_ROOT, '.test-data', 'agentfs-linux-build', 'target', 'release', 'agentfs-pod');
  }
}
const binOk = linuxBin.length > 0 && existsSync(linuxBin);
if (!binOk) {
  unavailable('no linux agentfs-pod binary; set XPOD_AGENTFS_LINUX_BIN or XPOD_AGENTFS_BUILD_LINUX=1 (Linux FUSE product build pending)');
}

const FIXTURE_JS = `import { createServer } from 'node:http';
const TOKEN = 'linux-token';
const files = new Map([['alpha.txt', Buffer.from('ALPHA_BODY_0123456789\\n')], ['big.txt', Buffer.from('x'.repeat(200000) + '\\nBIG_END\\n')]]);
const versions = new Map([...files.keys()].map((k) => [k, 1]));
const media = new Map([...files.keys()].map((k) => [k, 'text/plain']));
let dropNextPutReceipt = false;
const putCounts = new Map();
const etag = (v) => '"v' + v + '"';
createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const host = 'http://' + req.headers.host;
  const send = (s, b, h = {}) => { const p = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); res.writeHead(s, { 'content-type': 'application/json', 'content-length': p.length, ...h }); res.end(req.method === 'HEAD' ? undefined : p); };
  const auth = (req.headers.authorization || '') === 'Bearer ' + TOKEN;
  // Test-only OIDC issuer: exercises the installed client's existing credential
  // discovery/token path, without importing or mocking CLI source modules.
  if (url.pathname === '/.well-known/openid-configuration') {
    send(200, JSON.stringify({ token_endpoint: host + '/token' })); return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    let form = ''; req.on('data', (chunk) => form += chunk); req.on('end', () => {
      const data = new URLSearchParams(form);
      const valid = data.get('grant_type') === 'client_credentials' && data.get('client_id') === 'linux-client' && data.get('client_secret') === 'linux-secret';
      send(valid ? 200 : 401, JSON.stringify(valid ? { access_token: TOKEN, expires_in: 3600 } : {}));
    }); return;
  }
  const root = url.searchParams.get('root');
  const rootOk = (() => { try { const r = new URL(root); return r.origin === host && r.pathname.endsWith('/'); } catch { return false; } })();
  const raw = decodeURIComponent(url.pathname);
  if (raw === '/pod/') { send(auth ? 200 : 401, auth ? '' : '{}', { etag: '"dir"' }); return; }
  console.log(JSON.stringify({ method: req.method, path: url.pathname, query: url.search, range: req.headers.range || null }));
  if (!auth) { send(401, '{}'); return; }
  if (raw === '/__stats') { send(200, JSON.stringify(Object.fromEntries(putCounts))); return; }
  if (raw === '/__fault/drop-next-put-receipt' && req.method === 'POST') { dropNextPutReceipt = true; send(204, ''); return; }
  if (raw === '/__mutate' && req.method === 'POST') {
    const rel = url.searchParams.get('path'); const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      files.set(rel, Buffer.concat(chunks)); versions.set(rel, (versions.get(rel) || 0) + 1); send(204, '');
    }); return;
  }
  if (raw === '/-/agent-directory/list') {
    if (!rootOk) { send(400, '{"error":"root required"}'); return; }
    const prefix = url.searchParams.get('pathPrefix') || '';
    if (prefix.length > 0 && prefix.replace(/\\/+$/, '').split('/').some((s) => s.length === 0)) { send(400, '{"error":"invalid prefix"}'); return; }
    const entries = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k, type: 'file', size: files.get(k).length }));
    send(200, JSON.stringify({ entries, complete: true })); return;
  }
  const rel = raw.replace(/^\\/pod\\//, '');
  const body = files.get(rel);
  if (!body && req.method !== 'PUT') { send(404, '{}'); return; }
  if ((req.method === 'HEAD' || req.method === 'GET') && req.headers['if-match'] && req.headers['if-match'] !== etag(versions.get(rel))) { send(412, '{}'); return; }
  if (req.method === 'HEAD') { send(200, '', { etag: etag(versions.get(rel)), 'content-type': media.get(rel), 'content-length': body.length, 'accept-ranges': 'bytes' }); return; }
  if (req.method === 'GET') {
    const m = /bytes=(\\d+)-(\\d*)/.exec(req.headers.range || '');
    if (m) { const s = +m[1]; const e = m[2] ? +m[2] : body.length - 1; const slice = body.subarray(s, Math.min(e, body.length - 1) + 1); send(206, slice, { 'content-range': 'bytes ' + s + '-' + (s + slice.length - 1) + '/' + body.length, etag: etag(versions.get(rel)), 'accept-ranges': 'bytes' }); return; }
    send(200, body, { etag: etag(versions.get(rel)), 'content-type': media.get(rel), 'accept-ranges': 'bytes' }); return;
  }
  if (req.method === 'PUT') {
    putCounts.set(rel, (putCounts.get(rel) || 0) + 1);
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const create = req.headers['if-none-match'] === '*'; const match = req.headers['if-match'];
      if (create && files.has(rel)) { send(412, '{}'); return; }
      if (!create && (!files.has(rel) || etag(versions.get(rel)) !== match)) { send(412, '{}'); return; }
      files.set(rel, Buffer.concat(chunks)); media.set(rel, req.headers['content-type'] || 'application/octet-stream'); versions.set(rel, (versions.get(rel) || 0) + 1);
      if (dropNextPutReceipt) { dropNextPutReceipt = false; res.destroy(); return; }
      send(204, '', { etag: etag(versions.get(rel)) });
    }); return;
  }
  if (req.method === 'DELETE') {
    if (req.headers['if-match'] !== undefined && etag(versions.get(rel)) !== req.headers['if-match']) { send(412, '{}'); return; }
    files.delete(rel); send(204, ''); return;
  }
  send(405, '{}');
}).listen(8080, '0.0.0.0', () => console.log('fixture listening on 8080'));
`;
const fixturePath = path.join(WORK, 'fixture.mjs');
writeFileSync(fixturePath, FIXTURE_JS, 'utf8');

let image = 'node:22-bookworm-slim';
if (docker([ 'image', 'inspect', image ], { timeoutMs: 30_000 }).status !== 0 && docker([ 'pull', image ], { timeoutMs: 300_000 }).status !== 0) {
  image = 'oven/bun:1';
  if (docker([ 'image', 'inspect', image ], { timeoutMs: 30_000 }).status !== 0 && docker([ 'pull', image ], { timeoutMs: 300_000 }).status !== 0) {
    unavailable('no node/bun fixture image available');
  }
}

docker([ 'network', 'create', NET ], { timeoutMs: 30_000 });
const fixtureRun = docker([ 'run', '-d', '--name', FIXTURE, '--network', NET, '-v', `${fixturePath}:/fixture.mjs:ro`, image, 'sh', '-c', 'node /fixture.mjs 2>/dev/null || bun /fixture.mjs' ], { timeoutMs: 120_000 });
if (fixtureRun.status !== 0) {
  unavailable(`fixture container failed: ${fixtureRun.stderr.trim().slice(0, 160)}`);
}

const helperImage = 'rust@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e';
const helperRun = docker([ 'run', '-d', '--name', HELPER, '--network', NET, '--device', '/dev/fuse', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor:unconfined', '-v', `${linuxBin}:/usr/local/bin/agentfs-pod:ro`, ...(linuxInstall ? [ '-v', `${linuxInstall}:/candidate:ro` ] : []), helperImage, 'sleep', '3600' ], { timeoutMs: 120_000 });
if (helperRun.status !== 0) {
  unavailable(`helper container failed: ${helperRun.stderr.trim().slice(0, 160)}`);
}

const ops = [
  'set -e',
  'mkdir -p /mnt',
  'export XPOD_AGENTFS_TOKEN=linux-token',
  `export POD_ROOT=http://${FIXTURE}:8080/pod/`,
  `agentfs-pod mount --server "$POD_ROOT" --mountpoint /mnt --backend ${BACKEND} --session-dir /session --foreground &`,
  'MPID=$!',
  'trap "agentfs-pod unmount --mountpoint /mnt; kill $MPID 2>/dev/null || :" EXIT',
  'i=0; while [ $i -lt 30 ] && ! grep -q " /mnt " /proc/mounts; do sleep 1; i=$((i+1)); done',
  'grep -q " /mnt " /proc/mounts',
  'test "$(cat /mnt/alpha.txt)" = ALPHA_BODY_0123456789',
  'test "$(dd if=/mnt/alpha.txt bs=1 skip=6 count=9 status=none)" = BODY_0123',
  'printf "CREATED\\n" > /mnt/created.txt',
  'test "$(cat /mnt/created.txt)" = CREATED',
  'test "$(curl -s -H "Authorization: Bearer linux-token" -o /dev/null -w "%{http_code}" "${POD_ROOT}created.txt")" = 404',
  'agentfs-pod commit --pod-root "$POD_ROOT" --session-dir /session',
  'test "$(curl -fsS -H "Authorization: Bearer linux-token" "${POD_ROOT}created.txt")" = CREATED',
  'test "$(cat /mnt/created.txt)" = CREATED',
  'printf "REPLACED\\n" > /mnt/editor.tmp',
  'mv /mnt/editor.tmp /mnt/alpha.txt',
  'test "$(cat /mnt/alpha.txt)" = REPLACED',
  'test "$(curl -fsS -H "Authorization: Bearer linux-token" "${POD_ROOT}alpha.txt")" = ALPHA_BODY_0123456789',
  'agentfs-pod commit --pod-root "$POD_ROOT" --session-dir /session',
  'test "$(curl -fsS -H "Authorization: Bearer linux-token" "${POD_ROOT}alpha.txt")" = REPLACED',
  ...(linuxInstall ? [
    'export SOLID_HOME=/fixture-auth',
    'mkdir -p "$SOLID_HOME/auth"',
    `printf '%s' '{"url":"http://${FIXTURE}:8080/","webId":"http://${FIXTURE}:8080/pod/profile/card#me","authType":"client_credentials","secrets":{"clientId":"linux-client","clientSecret":"linux-secret"}}' > "$SOLID_HOME/auth/credentials.json"`,
    'chmod 600 "$SOLID_HOME/auth/credentials.json"',
    'export PATH=/candidate/bin:$PATH',
    'unset XPOD_AGENTFS_TOKEN XPOD_AGENTFS_HELPER',
    'test "$(xpodcli --version)" = 0.1.0-preview.1',
    'xpodcli agent-fs mount --pod-root "$POD_ROOT" --session-dir /cli-session --backend fuse',
    'grep -q " /cli-session/mnt " /proc/mounts',
    'printf "CLI_DIRTY\\n" > /cli-session/mnt/cli.txt',
    'test "$(curl -s -H "Authorization: Bearer linux-token" -o /dev/null -w "%{http_code}" "${POD_ROOT}cli.txt")" = 404',
    'xpodcli agent-fs unmount --session-dir /cli-session',
    'test ! -e /cli-session/proxy.json',
    '! grep -q " /cli-session/mnt " /proc/mounts',
    'xpodcli agent-fs mount --pod-root "$POD_ROOT" --session-dir /cli-session --backend fuse',
    'test "$(cat /cli-session/mnt/cli.txt)" = CLI_DIRTY',
    'sleep 2',
    'test "$(ps -eo comm,args | awk \'$1 == "agentfs-pod" && index($0, "--mountpoint /cli-session/mnt ") && index($0, "--foreground") { count++ } END { print count+0 }\')" = 1',
    'xpodcli agent-fs commit --pod-root "$POD_ROOT" --session-dir /cli-session',
    'test "$(curl -fsS -H "Authorization: Bearer linux-token" "${POD_ROOT}cli.txt")" = CLI_DIRTY',
    'printf "CLI_LOST\\n" > /cli-session/mnt/lost.txt',
    `curl -fsS -X POST -H 'Authorization: Bearer linux-token' http://${FIXTURE}:8080/__fault/drop-next-put-receipt`,
    'if xpodcli agent-fs commit --pod-root "$POD_ROOT" --session-dir /cli-session >/tmp/lost-receipt.log 2>&1; then cat /tmp/lost-receipt.log; exit 1; fi',
    `curl -fsS -H 'Authorization: Bearer linux-token' http://${FIXTURE}:8080/__stats | grep -Fq '"lost.txt":1'`,
    'xpodcli agent-fs recover --pod-root "$POD_ROOT" --session-dir /cli-session --json >/tmp/recovery.json',
    'grep -Fq \'"confirmed":["lost.txt"]\' /tmp/recovery.json',
    'test "$(cat /cli-session/mnt/lost.txt)" = CLI_LOST',
    'printf "CLI_LOCAL\\n" > /cli-session/mnt/alpha.txt',
    `curl -fsS -X POST -H 'Authorization: Bearer linux-token' --data CLI_REMOTE http://${FIXTURE}:8080/__mutate?path=alpha.txt`,
    'if xpodcli agent-fs commit --pod-root "$POD_ROOT" --session-dir /cli-session >/tmp/conflict.log 2>&1; then cat /tmp/conflict.log; exit 1; fi',
    'grep -q "conflict kept for alpha.txt" /tmp/conflict.log',
    'test "$(cat /cli-session/mnt/alpha.txt)" = CLI_LOCAL',
    'test "$(curl -fsS -H "Authorization: Bearer linux-token" "${POD_ROOT}alpha.txt")" = CLI_REMOTE',
    'xpodcli agent-fs unmount --session-dir /cli-session',
    'test ! -e /cli-session/proxy.json',
    '! grep -q " /cli-session/mnt " /proc/mounts',
    'sleep 2',
    'test "$(ps -eo comm,args | awk \'$1 == "agentfs-pod" && index($0, "--mountpoint /cli-session/mnt ") && index($0, "--foreground") { count++ } END { print count+0 }\')" = 0',
    'echo XPOD_LINUX_INSTALLED_CLI_OPS_PASSED',
  ] : []),
  'echo XPOD_LINUX_REQUIRED_OPS_PASSED',
  'kill $MPID 2>/dev/null || true',
].join('\n');
const exec = docker([ 'exec', HELPER, 'sh', '-c', ops ], { timeoutMs: 120_000 });
const opsLog = `${exec.stdout}\n${exec.stderr}`;
writeFileSync(path.join(WORK, 'helper-ops.log'), opsLog, 'utf8');
const fixtureLog = docker([ 'logs', FIXTURE ], { timeoutMs: 30_000 });
writeFileSync(path.join(WORK, 'fixture.log'), `${fixtureLog.stdout}\n${fixtureLog.stderr}`, 'utf8');

console.log('=== helper ops ===');
console.log(opsLog);
console.log('=== fixture request log (tail) ===');
console.log(fixtureLog.stdout.split('\n').slice(-40).join('\n'));

if (exec.status === 0 && opsLog.includes('XPOD_LINUX_REQUIRED_OPS_PASSED') && (!linuxInstall || opsLog.includes('XPOD_LINUX_INSTALLED_CLI_OPS_PASSED'))) {
  console.log(`STATUS: PASS (linux ${BACKEND} mount performed real file ops against the external fixture)`);
  writeReport({ status: 'pass', backend: BACKEND, work: WORK, installedCli: Boolean(linuxInstall) });
  process.exit(EXIT.ok);
}
console.log(`STATUS: FAIL (linux ${BACKEND} mount did not complete the required file operations)`);
writeReport({ status: 'fail', backend: BACKEND, work: WORK });
process.exit(EXIT.fail);
