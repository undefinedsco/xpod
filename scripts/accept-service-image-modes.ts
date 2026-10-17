/** Owned CI-only same-image acceptance. Never deploys to Kubernetes or adopts running services. */
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, statfs, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { setupAccount } from '../tests/integration/helpers/solidAccount';
import { createCloudAccountPassword, prepareManagedLocalAcceptancePod, parseKeyFile } from './accept-live-gateway-login-chat';
import { discoverSolidLocalRoute } from '../packages/solid-sdk/src/local-route-fetch';
const { MODES, CASES, LIMITS, hash, projectLive, validateMatrix, assertSafeJson } = require('./lib/service-image-modes.cjs');
const { runOwnedModeCommand } = require('./lib/owned-mode-command.cjs');
const { createModeEvidenceReader } = require('./lib/mode-evidence-reader.cjs');
const { PROFILES, validateInput, validateReceipt } = require('./lib/service-image-session-contract.cjs');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['scripts/accept-service-image-modes.ts', 'scripts/lib/service-image-modes.cjs', 'scripts/lib/owned-mode-command.cjs', 'scripts/lib/mode-evidence-reader.cjs', 'scripts/lib/mode-artifact-authority.cjs', 'scripts/verify-service-image-modes.cjs', 'scripts/lib/service-image-session-contract.cjs', 'scripts/accept-live-gateway-login-chat.ts', 'scripts/accept-service-image-session.ts', 'docker-compose.acceptance.yml', 'bun.lock'];
const need = (fact: unknown, message: string): void => { if (!fact) throw new Error(message); };
async function digest(file: string): Promise<string> { return hash(await readFile(file)); }
async function json(file: string): Promise<any> { return JSON.parse(await readFile(file, 'utf8')); }
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  need(port !== 60895, 'Reserved port selected'); return port;
}
/** Deployment-only material for this owned Cloud; never emitted into safe facts. */
export function ownedModeSecretCellEnvironment(mode: string, environment: Record<string, string>): Record<string, string> {
  if (mode !== 'cloud') return environment;
  const key = randomBytes(32);
  try {
    return { ...environment, XPOD_SECRET_CELL_KEY_ID: 'matrix-owned-v1', XPOD_SECRET_CELL_KEY: key.toString('base64') };
  } finally { key.fill(0); }
}
export async function runMatrix(options: { image: string; platform: string; sourceSha: string; runId: string; runAttempt: string; output: string; providerFile: string }): Promise<void> {
  need(process.platform === 'linux', 'Owned host-network matrix requires Linux CI');
  need(/^.+@sha256:[a-f0-9]{64}$/.test(options.image) && /^[a-f0-9]{40}$/.test(options.sourceSha), 'Immutable inputs required');
  need(/^[1-9][0-9]*$/.test(options.runId) && /^[1-9][0-9]*$/.test(options.runAttempt), 'Exact run/attempt required');
  need(options.platform === 'linux/amd64' || options.platform === 'linux/arm64', 'Unsupported matrix platform');
  const keyStat = await lstat(options.providerFile); need(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.size <= 65536 && (keyStat.mode & 0o077) === 0, 'Private0600 provider file required');
  need(parseKeyFile(await readFile(options.providerFile, 'utf8')), 'Explicit test provider configuration required');
  const output = path.resolve(options.output); await mkdir(output, { recursive: false, mode: 0o700 });
  let exportedBytes = 0;
  async function writeSafe(relative: string, bytes: Buffer): Promise<void> {
    need(bytes.length <= 1048576 && exportedBytes + bytes.length <= LIMITS.artifactBytes, 'Safe export budget exceeded');
    assertSafeJson(JSON.parse(bytes.toString()));
    const target = path.resolve(output, relative); need(target.startsWith(output + path.sep), 'Safe export escaped');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' }); exportedBytes += bytes.length;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'xpod-image-modes-'));
  const privateLogs = path.join(root, 'logs'); await mkdir(privateLogs);
  const project = `xpod-modes-${process.pid}-${Date.now().toString(36)}`;
  const composeFile = path.join(root, 'compose.json');
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const commands: any[] = []; const deadline = Date.now() + 55 * 60_000;
  const report: any = { schemaVersion: 1, ...options, output: undefined, providerFile: undefined, status: 'failed', sources: {}, modes: [], commands, cleanup: {} };
  let composeCreated = false; let copiedContainer = false;
  const copyName = `${project}-config`;
  async function command(label: string, binary: string, args: string[], cwd = repo, env = process.env, timeoutMs = LIMITS.commandMs, cleanup = false, terminationGraceMs = 1000): Promise<Buffer> {
    need(cleanup || !cancellation.signal.aborted && Date.now() < deadline, 'Matrix total budget exhausted');
    const result = await runOwnedModeCommand(binary, args, { cwd, env, timeoutMs: Math.min(timeoutMs, cleanup ? timeoutMs : Math.max(1, deadline - Date.now())), outputBytes: LIMITS.outputBytes, signal: cleanup ? undefined : cancellation.signal, terminationGraceMs });
    const raw = [result.stdout, result.stderr];
    for (let i = 0; i < raw.length; i++) await writeFile(path.join(privateLogs, `${commands.length}-${i}.raw`), raw[i], { mode: 0o600 });
    const row = { label, ...result.record }; commands.push(row);
    need(row.closeObserved && row.exitObserved && row.rawEligible && !row.forcedCleanup && !row.cancelled && !row.spawnFailed && !row.ownershipUnknown && !row.outputTruncated && !row.timedOut && row.code === 0 && !row.signal && row.groupAbsent, `Owned command failed: ${label}`);
    return raw[0];
  }
  const docker = (label: string, args: string[], cleanup = false) => command(label, 'docker', args, repo, process.env, cleanup ? LIMITS.cleanupMs : LIMITS.commandMs, cleanup);
  const compose = (label: string, args: string[], cleanup = false) => docker(label, ['compose', '-p', project, '-f', composeFile, ...args], cleanup);
  let configuration: any;
  try {
    for (const f of sources) report.sources[f] = await digest(path.join(repo, f));
    const actual = (await command('exact-checkout', 'git', ['rev-parse', 'HEAD'])).toString().trim(); need(actual === options.sourceSha, 'Checkout mismatch');
    const fs = await statfs(root); need(Number(fs.bavail) * Number(fs.bsize) >= 8 * 1024 ** 3, 'At least8GiB disk required before image pull');
    const manifestRaw = await docker('image-manifest-metadata', ['manifest', 'inspect', options.image]);
    const manifest = JSON.parse(manifestRaw.toString());
    let layerManifest = manifest;
    if (manifest.manifests) {
      const [os, architecture] = options.platform.split('/');
      const selected = manifest.manifests.filter((m: any) => m.platform?.os === os && m.platform?.architecture === architecture);
      need(selected.length === 1, 'Exact platform manifest required');
      layerManifest = JSON.parse((await docker('platform-manifest-metadata', ['manifest', 'inspect', options.image.split('@')[0] + '@' + selected[0].digest])).toString());
    }
    need(Array.isArray(layerManifest.layers) && layerManifest.layers.every((x: any) => Number.isSafeInteger(x.size) && x.size >= 0), 'Bounded image layer metadata required');
    const compressedBytes = layerManifest.layers.reduce((n: number, x: any) => n + x.size, 0);
    need(compressedBytes <= 4 * 1024 ** 3 && Number(fs.bavail) * Number(fs.bsize) >= compressedBytes * 4 + 2 * 1024 ** 3, 'Image pull/unpack admission budget exceeded');
    report.pullBudget = { compressedBytes, unpackReservationFactor: 4 };
    await docker('pull-exact-image', ['pull', '--platform', options.platform, options.image]);
    const image = JSON.parse((await docker('inspect-image', ['image', 'inspect', options.image])).toString())[0];
    need(`${image.Os}/${image.Architecture}` === options.platform && image.RepoDigests.includes(options.image), 'Resolved image/platform mismatch');
    need(image.Config.Labels?.['org.opencontainers.image.revision'] === options.sourceSha, 'Image source revision mismatch');
    report.imageId = image.Id;
    await docker('create-owned-config-reader', ['create', '--name', copyName, options.image]); copiedContainer = true;
    await docker('copy-image-config', ['cp', `${copyName}:/app/config/main.json`, path.join(root, 'main.original.json')]);
    await docker('remove-owned-config-reader', ['rm', '--volumes', copyName]); copiedContainer = false;
    report.baseConfigSHA256 = await digest(path.join(root, 'main.original.json'));
    const canonical = YAML.parse(await readFile(path.join(repo, 'docker-compose.acceptance.yml'), 'utf8'));
    delete canonical.services.acceptance;
    const ports: Record<string, number> = {}; for (const name of ['postgres', 'redis', 'minio', ...MODES]) ports[name] = await freePort();
    need(new Set(Object.values(ports)).size === 6, 'Port reservation collision');
    const urls = { cloud: `http://localhost:${ports.cloud}/`, local: `http://127.0.0.1:${ports.local}/`, standalone: `http://localhost:${ports.standalone}/` };
    for (const name of ['postgres', 'redis', 'minio']) canonical.services[name].ports = [`127.0.0.1:${ports[name]}:${name === 'postgres' ? 5432 : name === 'redis' ? 6379 : 9000}`];
    for (const mode of MODES) {
      const service = canonical.services[mode]; service.image = options.image; service.platform = options.platform;
      service.network_mode = 'host'; delete service.networks; delete service.ports;
      service.command = ['bun', '--no-env-file', 'dist/runtime/service-entry.js', 'start', '--mode', mode === 'cloud' ? 'cloud' : 'local', '--port', String(ports[mode]), '--host', '127.0.0.1'];
      service.environment = ownedModeSecretCellEnvironment(mode, service.environment);
      service.environment.XPOD_RDF_NATIVE_SPARQL_ENABLED = 'false'; service.environment.XPOD_PORT = String(ports[mode]);
      if (mode !== 'local') service.environment.CSS_BASE_URL = urls[mode as 'cloud' | 'standalone'];
      service.environment.SOLID_OIDC_ISSUER = mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'];
      if (mode === 'cloud') Object.assign(service.environment, { CSS_IDENTITY_DB_URL: `postgres://xpod:acceptance-only@127.0.0.1:${ports.postgres}/xpod`, CSS_SPARQL_ENDPOINT: `postgres://xpod:acceptance-only@127.0.0.1:${ports.postgres}/xpod`, CSS_REDIS_CLIENT: `127.0.0.1:${ports.redis}`, CSS_MINIO_ENDPOINT: `http://127.0.0.1:${ports.minio}` });
      if (service.healthcheck) service.healthcheck.test = ['CMD', 'curl', '--fail', '--silent', `${urls[mode as keyof typeof urls]}.well-known/openid-configuration`];
    }
    configuration = canonical;
    const saveConfig = async () => writeFile(composeFile, JSON.stringify(configuration), { mode: 0o600 });
    await saveConfig(); composeCreated = true;
    await compose('start-base-topology', ['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'minio', 'cloud', 'local']);
    const modeReports: Record<string, any> = {};
    async function waitRuntime(mode: string): Promise<any[]> {
      for (let n = 0; n < 90; n++) {
        need(!cancellation.signal.aborted && Date.now() < deadline, 'Runtime wait cancelled');
        try { const response = await fetch(new URL('service/status', urls[mode as keyof typeof urls]), { signal: AbortSignal.timeout(2000) }); const rows = await response.json() as any[]; if (response.ok && ['css', 'api'].every(k => rows.some(x => x.name === k && x.status === 'running'))) return rows; } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      } throw new Error('Owned runtime not ready');
    }
    async function inspectMode(mode: string): Promise<any> {
      const id = (await compose(`container-id-${mode}`, ['ps', '-q', mode])).toString().trim(); need(/^[a-f0-9]+$/.test(id), 'Owned container missing');
      const c = JSON.parse((await docker(`inspect-${mode}`, ['inspect', id])).toString())[0];
      need(c.Image === image.Id && c.Config.Image === options.image, 'Running image mismatch');
      const mounts = c.Mounts.map((m: any) => ({ destination: m.Destination, type: m.Type, readOnly: !m.RW }));
      need(mounts.every((m: any) => m.destination === '/app/data' && m.type === 'volume' || m.destination === '/app/config/main.json' && m.type === 'bind' && m.readOnly), 'Unexpected service mount');
      const statuses = await waitRuntime(mode); const pids = [1, ...['css', 'api'].map(k => statuses.find(x => x.name === k).pid)];
      need(pids.every(pid => Number.isSafeInteger(pid) && pid > 0), 'Runtime PID missing');
      const executables = (await docker(`runtime-exe-${mode}`, ['exec', id, 'readlink', ...pids.map(pid => `/proc/${pid}/exe`)])).toString().trim().split('\n');
      need(executables.length === 3 && executables.every(x => /\/bun$/.test(x)), 'Actual service runtime is not Bun');
      return { reference: options.image, platform: options.platform, id: c.Image, repoDigests: image.RepoDigests, mounts, noCodeMounts: true, runtimeExecutables: executables };
    }
    for (const mode of MODES) {
      if (mode === 'standalone') {
        await compose('stop-managed-base', ['stop', '--timeout', '20', 'local', 'cloud']);
        await compose('start-standalone-base', ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'standalone']);
      }
      const facts = await inspectMode(mode); const directory = path.join(root, `live-${mode}`); await mkdir(directory);
      await command(`live-${mode}`, process.execPath, [path.join(repo, 'scripts/accept-live-gateway-login-chat.ts')], directory, { ...process.env, XPOD_LIVE_MODE: mode, XPOD_BASE_URL: urls[mode as keyof typeof urls], XPOD_LIVE_CLOUD_IDP: urls.cloud, XPOD_LIVE_PROVIDER_KEY_FILE: options.providerFile, XPOD_LIVE_TASK_APPROVAL: '0' }, LIMITS.liveMs);
      const liveReader = await createModeEvidenceReader(path.join(directory, '.test-data/acceptance'));
      const liveBytes = await liveReader.read(`live-gateway-login-chat-${mode}.json`);
      const live = JSON.parse(liveBytes.toString()); assertSafeJson(live);
      await writeSafe(`live-${mode}.original.json`, liveBytes);
      modeReports[mode] = { mode, baseUrl: urls[mode as keyof typeof urls], issuer: mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'], image: facts, live: projectLive(live, mode), liveOriginalSHA256: hash(liveBytes), sessions: [], sessionBindings: {} };
    }
    for (const kind of CASES) {
      await compose(`stop-for-${kind}`, ['stop', '--timeout', '20', ...MODES]);
      const policyPath = path.join(root, `main-${kind}.json`); const policyReceipt = path.join(root, `policy-${kind}.json`);
      await command(`derive-policy-${kind}`, process.execPath, [path.join(repo, 'scripts/accept-service-image-session.ts'), 'derive-config', path.join(root, 'main.original.json'), policyPath, kind, policyReceipt]);
      const policy = await json(policyReceipt);
      need(policy.originalConfigSHA256 === report.baseConfigSHA256 && policy.derivedConfigSHA256 === await digest(policyPath) && policy.accessTokenTtl === PROFILES[kind].accessTokenTtl && policy.refreshTokenTtl === PROFILES[kind].refreshTokenTtl, 'Derived policy binding mismatch');
      report.policyConfigs ??= {}; report.policyConfigs[kind] = policy;
      for (const mode of MODES) configuration.services[mode].volumes = [`${mode}:/app/data`, `${policyPath}:/app/config/main.json:ro`];
      await saveConfig(); await compose(`start-${kind}`, ['up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '180', 'cloud', 'local']);
      for (const mode of MODES) {
        if (mode === 'standalone') {
          await compose(`stop-managed-${kind}`, ['stop', '--timeout', '20', 'local', 'cloud']);
          await compose(`start-standalone-${kind}`, ['up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '180', 'standalone']);
        }
        await inspectMode(mode);
        const directory = path.join(root, `browser-${mode}-${kind}`); await mkdir(directory);
        const preparation = path.join(directory, 'private-prepare-input.json');
        const accountFile = path.join(directory, 'private-account.json');
        await writeFile(preparation, JSON.stringify({ mode, urls, kind }), { mode: 0o600 });
        await command(`account-${mode}-${kind}`, process.execPath, [path.join(repo, 'scripts/accept-service-image-modes.ts'), 'prepare-account', preparation, accountFile], repo, process.env, 120_000);
        const account = await json(accountFile);
        need(account?.email && account?.password && account?.webId && account?.podUrl, 'Owned browser account incomplete');
        const sessionOutput = path.join(directory, 'safe'); await mkdir(sessionOutput, { mode: 0o700 });
        const input = { schemaVersion: 1, sourceSha: options.sourceSha, mode, baseUrl: urls[mode as keyof typeof urls], issuer: mode === 'local' ? urls.cloud : urls[mode as 'cloud' | 'standalone'], image: { reference: options.image, platform: options.platform, id: image.Id }, profile: { kind, ...policy }, binding: { webId: account.webId, podUrl: account.podUrl }, ownershipRoot: root, accountFile, outputDirectory: sessionOutput };
        validateInput(input);
        const manifest = path.join(directory, 'private-input.json'); await writeFile(manifest, JSON.stringify(input), { mode: 0o600 });
        await command(`browser-${mode}-${kind}`, 'xvfb-run', ['--auto-servernum', process.execPath, path.join(repo, 'scripts/accept-service-image-session.ts'), 'run', manifest], repo, process.env, LIMITS.browserMs, false, 10_000);
        const browserReader = await createModeEvidenceReader(sessionOutput);
        const receiptBytes = await browserReader.read('session.safe.json'); const session = JSON.parse(receiptBytes.toString()); assertSafeJson(session);
        validateReceipt(session, input);
        for (const [f, sha] of Object.entries(session.sources)) need(await digest(path.join(repo, f)) === sha, 'Browser source binding mismatch');

        for (const original of session.originals) {
          const bytes = await browserReader.read(original.path); assertSafeJson(JSON.parse(bytes.toString())); need(bytes.length === original.bytes && hash(bytes) === original.sha256, 'Session original mismatch');
          await writeSafe(path.join(`session-${mode}-${kind}`, original.path), bytes);
        }
        await writeSafe(path.join(`session-${mode}-${kind}`, 'session.safe.json'), receiptBytes);
        modeReports[mode].sessionBindings[kind] = input.binding;
        modeReports[mode].sessions.push({ ...session, receiptSHA256: hash(receiptBytes) });
      }
    }
    need(!cancellation.signal.aborted, 'Matrix cancelled');
    report.modes = MODES.map((mode: string) => modeReports[mode]); report.status = 'passed';
  } catch { report.status = 'failed'; report.failure = 'owned-matrix-stage-failed'; }
  finally {
    try {
      if (copiedContainer) await docker('cleanup-config-reader', ['rm', '-f', '--volumes', copyName], true);
      if (composeCreated) await compose('cleanup-owned-topology', ['down', '--volumes', '--remove-orphans', '--timeout', '20'], true);
      for (const [resource, key] of [['container', 'containersAbsent'], ['volume', 'volumesAbsent'], ['network', 'networkAbsent']]) {
        const ids = (await docker(`absence-${resource}`, [resource === 'container' ? 'ps' : resource, ...(resource === 'container' ? ['-aq'] : ['ls', '-q']), '--filter', `label=com.docker.compose.project=${project}`], true)).toString().trim(); need(!ids, 'Owned Docker resource remains'); report.cleanup[key] = true;
      }
      const readers = (await docker('absence-config-reader', ['ps', '-aq', '--filter', `name=^/${copyName}$`], true)).toString().trim(); need(!readers, 'Config reader remains');
      report.cleanup.ownedCommandsClosed = commands.every(c => c.waitKnown && c.closeObserved && c.groupAbsent);
      for (const f of sources) need(await digest(path.join(repo, f)) === report.sources[f], 'Runner source changed');
      report.cancelled = cancellation.signal.aborted;
      if (report.status === 'passed') validateMatrix(report, options);
    } catch { report.status = 'failed'; report.failure = 'owned-matrix-or-cleanup-incomplete'; }
    await writeSafe('matrix.safe.json', Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    // Private credentials, browser state and raw server/client output never enter public artifacts.
    // Retain private raw originals on failure for the owning CI runner; never upload this directory.
    if (report.status === 'passed') await rm(root, { recursive: true, force: true });
  }
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  need(report.status === 'passed', 'Same-image mode matrix failed; see safe receipt');
}
async function main(): Promise<void> {
  const [action, file] = process.argv.slice(2);
  if (action === 'prepare-account') {
    const { mode, urls, kind } = await json(file); let account: any;
    need(PROFILES[kind] && MODES.includes(mode), 'Known owned account input required');
    for (const url of Object.values(urls) as string[]) { const u = new URL(url); need(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && u.port && Number(u.port) !== 60895 && !u.username && !u.password, 'Owned loopback account target required'); }
    if (mode === 'local') {
      const owner = await createCloudAccountPassword(urls.cloud, `refresh-${kind}`);
      const route = await discoverSolidLocalRoute({ fetch, localBaseUrl: urls.local, statusUrl: new URL('provision/status', urls.local).href }); need(route, 'Managed local route unavailable');
      const state = await (await fetch(new URL('provision/status', urls.local), { signal: AbortSignal.timeout(5000) })).json() as { provisionCode: string; registered: boolean };
      need(state.registered === true && typeof state.provisionCode === 'string' && state.provisionCode.trim(), 'Active managed provision code required');
      const binding = await prepareManagedLocalAcceptancePod({ baseUrl: urls.cloud, localBaseUrl: urls.local, canonicalBaseUrl: route!.canonicalBaseUrl, authorization: owner.authorization, controls: owner.controls, username: `refresh-${Date.now().toString(36)}`, provisionCode: state.provisionCode });
      account = { email: owner.email, password: owner.password, webId: binding.webId, podUrl: binding.storageUrl };
    } else { need(mode === 'cloud' || mode === 'standalone', 'Invalid account deployment'); account = await setupAccount(urls[mode], `refresh-${kind}`); }
    need(account?.email && account?.password && account?.webId && account?.podUrl, 'Owned browser account incomplete');
    await writeFile(process.argv[4], JSON.stringify({ email: account.email, password: account.password, webId: account.webId, podUrl: account.podUrl }), { mode: 0o600, flag: 'wx' }); return;
  }
  need(action === 'run', 'Expected run or verify');
  await runMatrix({ image: process.env.XPOD_MATRIX_IMAGE!, platform: process.env.XPOD_MATRIX_PLATFORM!, sourceSha: process.env.GITHUB_SHA!, runId: process.env.GITHUB_RUN_ID!, runAttempt: process.env.GITHUB_RUN_ATTEMPT!, providerFile: process.env.XPOD_LIVE_PROVIDER_KEY_FILE!, output: file });
}
if (import.meta.main) main().catch(() => { console.error('Service image mode acceptance failed (private details withheld)'); process.exitCode = 1; });
