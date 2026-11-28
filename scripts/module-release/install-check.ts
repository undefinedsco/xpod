#!/usr/bin/env bun
/**
 * Clean install and real start of a module release (docs/module-publication-v2.md §3 step 3).
 *
 * The CLI and client tarballs are laid out like an npm install (no lifecycle scripts)
 * under an isolated HOME. The installed CLI then runs `xpod module install` with a
 * preloaded shim that answers the npm registry requests for this one package from
 * the local tarball, so download, integrity check, verification and activation are
 * the code users run. Finally the CLI starts the module under each runtime and the
 * check waits for it to become ready.
 *
 * Usage: bun scripts/module-release/install-check.ts --cli <cli.tgz> --client <client.tgz>
 *          [--module <api|css|afs> --package <module.tgz>] [--runtimes bun,node] --out <dir>
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';
const READY_TIMEOUT_MS = 180_000;

export interface InstallCheckResult { runtime: string; step: string; ok: boolean; detail?: string }

function unpack(tarball: string, destination: string): Record<string, unknown> {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1', '--no-same-owner'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cannot unpack ${tarball}: ${result.stderr.trim()}`);
  return JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'));
}

/**
 * Preloaded into the CLI process: answers the npm registry metadata and tarball
 * requests for exactly one package from a local file; every other request goes out
 * unchanged. Used only to install a release candidate before it is published.
 */
export function registryShimSource(name: string, version: string, tarball: string): string {
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const metadataUrl = `${REGISTRY}/${encodeURIComponent(name)}/${version}`;
  const tarballUrl = `${REGISTRY}/${name}/-/module-${version}.tgz`;
  return `import { readFileSync } from 'node:fs';
const original = globalThis.fetch;
const metadata = ${JSON.stringify(JSON.stringify({ name, version, dist: { integrity, tarball: tarballUrl } }))};
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === ${JSON.stringify(metadataUrl)}) return new Response(metadata, { headers: { 'content-type': 'application/json' } });
  if (url === ${JSON.stringify(tarballUrl)}) return new Response(readFileSync(${JSON.stringify(tarball)}));
  return original(input, init);
};
`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Start a long-running command in its own process group and wait until `ready` passes. */
async function startUntilReady(command: string, args: string[], env: NodeJS.ProcessEnv, logFile: string,
  ready: () => Promise<boolean>): Promise<string | undefined> {
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
  let exited: number | null | undefined;
  child.once('exit', code => { exited = code; });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let failure: string | undefined;
  for (;;) {
    if (exited !== undefined) { failure = `exited with ${exited} before becoming ready`; break; }
    if (await ready().catch(() => false)) break;
    if (Date.now() > deadline) { failure = 'not ready before the deadline'; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise(resolve => (exited !== undefined ? resolve(undefined) : child.once('exit', resolve)));
  writeFileSync(logFile, Buffer.concat(output));
  return failure;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
  return response.ok ? response.json() : undefined;
}

export async function installCheck(options: { cli: string; client: string; module?: 'api' | 'css' | 'afs'; modulePackage?: string;
  runtimes: string[]; out: string }): Promise<InstallCheckResult[]> {
  const results: InstallCheckResult[] = [];
  const record = (runtime: string, step: string, failure?: string) => results.push({ runtime, step, ok: !failure, ...(failure ? { detail: failure } : {}) });
  mkdirSync(options.out, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), 'xpod-install-check-'));
  try {
    const home = path.join(work, 'home');
    const modules = path.join(work, 'project', 'node_modules', '@undefineds.co');
    mkdirSync(home, { recursive: true });
    const client = unpack(options.client, path.join(modules, 'xpod-client'));
    const cli = unpack(options.cli, path.join(modules, 'xpod-cli'));
    const deps = (cli.dependencies ?? {}) as Record<string, string>;
    const extra = Object.keys(deps).filter(name => name !== '@undefineds.co/xpod-client');
    if (extra.length) record('-', 'cli-self-contained', `CLI declares dependencies beyond the client: ${extra.join(', ')}`);
    else if (deps['@undefineds.co/xpod-client'] !== client.version) record('-', 'cli-self-contained', `CLI requires client ${deps['@undefineds.co/xpod-client']}, got ${client.version}`);
    else record('-', 'cli-self-contained');
    const entry = path.join(modules, 'xpod-cli', 'dist', 'xpod.mjs');
    const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1' };

    if (options.module && options.modulePackage) {
      const manifest = JSON.parse(spawnSync('tar', ['-xzOf', options.modulePackage, 'package/package.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout);
      const shim = path.join(work, 'registry-shim.mjs');
      writeFileSync(shim, registryShimSource(manifest.name, manifest.version, options.modulePackage));
      const runtime = options.runtimes[0] ?? 'bun';
      const preload = runtime === 'node' ? ['--import', shim] : ['--preload', shim];
      const install = spawnSync(runtime, [...preload, entry, 'module', 'install', options.module, '--version', manifest.version],
        { env, encoding: 'utf8', timeout: 600_000 });
      writeFileSync(path.join(options.out, `install-${options.module}.log`), `${install.stdout}\n${install.stderr}`);
      record(runtime, `install-${options.module}`, install.status === 0 ? undefined : `exit ${install.status}: ${(install.stderr || install.stdout || '').slice(0, 600)}`);
    }

    for (const runtime of options.runtimes) {
      const help = spawnSync(runtime, [entry, '--help'], { env, encoding: 'utf8', timeout: 60_000 });
      record(runtime, 'cli-help', help.status === 0 ? undefined : `exit ${help.status}: ${(help.stderr || '').slice(0, 400)}`);
      const list = spawnSync(runtime, [entry, 'module', 'list'], { env, encoding: 'utf8', timeout: 60_000 });
      record(runtime, 'cli-module-list', list.status === 0 ? undefined : `exit ${list.status}: ${(list.stderr || '').slice(0, 400)}`);
      if (!options.module || !results.some(row => row.step === `install-${options.module}` && row.ok)) continue;
      const port = await freePort();
      const log = path.join(options.out, `${runtime}-${options.module}.log`);
      if (options.module === 'api') {
        const base = `http://127.0.0.1:${port}/`;
        const failure = await startUntilReady(runtime, [entry, 'api'], {
          ...env, XPOD_EDITION: 'cloud', CSS_IDENTITY_DB_URL: 'sqlite::memory:', API_HOST: '127.0.0.1', API_PORT: String(port),
          CSS_BASE_URL: base, CSS_ROOT_FILE_PATH: path.join(work, `api-data-${runtime}`), CSS_LOGGING_LEVEL: 'warn',
          XPOD_INNGEST_ENABLED: 'false', XPOD_NODE_ID: `module-release-${runtime}`,
        }, log, async () => JSON.stringify(await getJson(`${base}health`)) === '{"status":"ok"}');
        record(runtime, 'api-health', failure);
      } else if (options.module === 'css') {
        const issuer = `http://localhost:${port}/`;
        const failure = await startUntilReady(runtime, [entry, 'start', '--modules', 'css', '--mode', 'local', '--port', String(port),
          '--baseUrl', issuer, '--data', path.join(work, `css-data-${runtime}`)], env, log,
          async () => ((await getJson(`${issuer}.well-known/openid-configuration`)) as { issuer?: string } | undefined)?.issuer === issuer);
        record(runtime, 'css-oidc-discovery', failure);
      } else {
        const afs = spawnSync(runtime, [entry, 'afs', '--help'], { env, encoding: 'utf8', timeout: 120_000 });
        record(runtime, 'afs-help', afs.status === 0 ? undefined : `exit ${afs.status}: ${(afs.stderr || '').slice(0, 400)}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(path.join(options.out, 'install-report.json'), JSON.stringify({ ok: results.every(row => row.ok), results }, null, 2) + '\n');
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
  const cli = option('--cli'), client = option('--client'), out = option('--out');
  const module = option('--module') as 'api' | 'css' | 'afs' | undefined;
  if (!cli || !client || !out || (module && !['api', 'css', 'afs'].includes(module)) || (module && !option('--package'))) {
    console.error('usage: install-check.ts --cli <cli.tgz> --client <client.tgz> [--module <api|css|afs> --package <module.tgz>] [--runtimes bun,node] --out <dir>');
    process.exit(64);
  }
  const results = await installCheck({ cli: path.resolve(cli), client: path.resolve(client), module, modulePackage: option('--package') && path.resolve(option('--package')!),
    runtimes: (option('--runtimes') ?? 'bun,node').split(',').filter(Boolean), out: path.resolve(out) });
  for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.runtime.padEnd(4)} ${row.step}${row.detail ? ` — ${row.detail}` : ''}`);
  process.exit(results.every(row => row.ok) ? 0 : 1);
}
