/**
 * SakuraFrp client compatibility probe.
 *
 * Decides one question with evidence instead of documentation: can an upstream frpc (the
 * Apache-2.0 client we may bundle) drive a SakuraFrp tunnel, or does Sakura require the
 * vendor's own build? It reads the operator's access key, asks the SakuraFrp API for the
 * tunnel and for a config generated for a chosen upstream frpc version, serves a marker
 * from the tunnel's local port, and then probes the assigned public entry.
 *
 * Nothing here changes the product; it exists so the bundling decision (N16) rests on a
 * live run. Secrets are never printed, and the marker is the only thing requested back.
 *
 * Usage:
 *   bun scripts/probe-sakura-clients.ts --env-file .env.acceptance
 *   bun scripts/probe-sakura-clients.ts --tunnel-id 114514 --frpc /path/to/frpc
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const SAKURA_API_BASE = 'https://api.natfrp.com/v4';
/** The upstream client the probe drives; the API answers with a matching config file. */
const PROBE_FRPC_VERSION = '0.71.0';

export interface SakuraTunnel {
  id: number;
  name?: string;
  node?: number;
  type?: string;
  local_ip?: string;
  local_port?: number;
  remote?: string;
  extra?: string;
  online?: boolean;
}

export interface SakuraNode {
  name?: string;
  host?: string;
}

/**
 * Picks the tunnel to probe.
 *
 * An account with no tunnel is a state the caller must see as such: silently probing
 * "nothing" would look like an incompatible client.
 */
export function selectSakuraTunnel(tunnels: readonly SakuraTunnel[], tunnelId?: number): SakuraTunnel {
  if (!Array.isArray(tunnels) || tunnels.length === 0) {
    throw new Error('the SakuraFrp account has no tunnel; create one in the console first');
  }
  if (tunnelId === undefined) {
    return tunnels[0];
  }
  const match = tunnels.find((tunnel) => Number(tunnel.id) === tunnelId);
  if (!match) {
    throw new Error(`no tunnel with id ${tunnelId} in this account`);
  }
  return match;
}

/** TCP tunnels are addressed by node host plus the assigned remote port. */
export function composeSakuraEntry(
  tunnel: SakuraTunnel,
  nodes: Record<string, SakuraNode>,
): { url?: string; reason?: string } {
  const remote = tunnel.remote?.trim();
  if (!remote) {
    return { reason: 'the tunnel has no assigned remote address yet' };
  }
  if (/[a-z]/iu.test(remote)) {
    return { url: `https://${remote.replace(/^https?:\/\//u, '').replace(/\/+$/u, '')}/` };
  }
  const host = tunnel.node === undefined ? undefined : nodes[String(tunnel.node)]?.host?.trim();
  if (!host) {
    return { reason: `node ${tunnel.node ?? 'unknown'} publishes no host, so the address cannot be derived` };
  }
  const scheme = tunnel.type === 'https' || /auto_https\s*=\s*(auto|on|true)/iu.test(tunnel.extra ?? '')
    ? 'https'
    : 'http';
  return { url: `${scheme}://${host.replace(/^https?:\/\//u, '').replace(/\/+$/u, '')}:${remote}/` };
}

function parseArgs(argv: string[]): { envFile: string; tunnelId?: number; frpc: string; timeoutMs: number } {
  const options = {
    envFile: path.resolve('.env.acceptance'),
    tunnelId: undefined as number | undefined,
    frpc: path.resolve('.test-data/vendor/frp/frp_0.71.0_darwin_arm64/frpc'),
    timeoutMs: 90_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--env-file': options.envFile = path.resolve(next()); break;
      case '--tunnel-id': options.tunnelId = Number(next()); break;
      case '--frpc': options.frpc = path.resolve(next()); break;
      case '--timeout-ms': options.timeoutMs = Number(next()); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readCredential(envFile: string): { accessKey: string; tunnelIds: number[] } {
  if (!existsSync(envFile)) {
    throw new Error(`credential file ${envFile} does not exist; pass --env-file <path>`);
  }
  const value = readFileSync(envFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('SAKURA_TUNNEL_TOKEN='))
    ?.slice('SAKURA_TUNNEL_TOKEN='.length)
    .trim();
  if (!value) {
    throw new Error('SAKURA_TUNNEL_TOKEN is not set in the credential file');
  }
  const separator = value.indexOf(':');
  const accessKey = separator < 0 ? value : value.slice(0, separator);
  const tunnelIds = separator < 0
    ? []
    : value.slice(separator + 1).split(',').map((id) => Number(id.trim())).filter((id) => Number.isFinite(id));
  return { accessKey, tunnelIds };
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

async function apiGet<T>(pathname: string, accessKey: string): Promise<T> {
  const response = await fetch(`${SAKURA_API_BASE}${pathname}`, {
    headers: { authorization: `Bearer ${accessKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`${pathname} answered ${response.status}`);
  }
  return await response.json() as T;
}

/** Asks the platform for a config file written for the given upstream frpc version. */
export async function fetchFrpcConfig(accessKey: string, tunnelId: number, frpcVersion: string): Promise<string> {
  const body = new URLSearchParams({ query: String(tunnelId), frpc: frpcVersion });
  const response = await fetch(`${SAKURA_API_BASE}/tunnel/config`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/plain, text/toml',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`/tunnel/config answered ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

async function startMarkerServer(host: string, port: number, marker: string): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(marker);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

async function probeEntry(url: string, marker: string, timeoutMs: number): Promise<{ ok: boolean; observed: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      const body = await response.text();
      last = `${response.status} · ${body.trim().slice(0, 80)}`;
      if (response.ok && body.includes(marker)) {
        return { ok: true, observed: last };
      }
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { ok: false, observed: last };
}

function stop(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { accessKey, tunnelIds } = readCredential(options.envFile);
  const checkpoint = path.resolve('.test-data/acceptance/sakura-client-probe', String(Date.now()));
  mkdirSync(checkpoint, { recursive: true });

  const tunnels = await apiGet<SakuraTunnel[]>('/tunnels', accessKey);
  const tunnel = selectSakuraTunnel(tunnels, options.tunnelId ?? tunnelIds[0]);
  const nodes = await apiGet<Record<string, SakuraNode>>('/nodes', accessKey);
  const entry = composeSakuraEntry(tunnel, nodes);
  const localHost = tunnel.local_ip?.trim() || '127.0.0.1';
  const localPort = tunnel.local_port ?? 0;
  const marker = `XPOD-SAKURA-PROBE-${randomUUID()}`;

  console.log(`[probe] tunnel ${tunnel.id} (${tunnel.name ?? 'unnamed'}) type=${tunnel.type ?? '?'} node=${tunnel.node ?? '?'}`);
  console.log(`[probe] origin ${localHost}:${localPort}; credential ${fingerprint(accessKey)}`);
  console.log(`[probe] assigned entry: ${entry.url ?? `unknown (${entry.reason})`}`);

  const results: Array<Record<string, unknown>> = [];
  let server: Server | undefined;
  let client: ChildProcess | undefined;
  try {
    server = await startMarkerServer(localHost, localPort, marker);

    let configPath: string | undefined;
    let configError: string | undefined;
    try {
      const config = await fetchFrpcConfig(accessKey, tunnel.id, PROBE_FRPC_VERSION);
      configPath = path.join(checkpoint, 'frpc.toml');
      writeFileSync(configPath, config);
      // The file is the platform's answer: record its shape, never the secret it contains.
      const keys = config.split('\n').map((line) => line.trim()).filter((line) => line.includes('=') && !line.startsWith('#'))
        .map((line) => line.slice(0, line.indexOf('=')).trim());
      console.log(`[probe] platform config for frpc ${PROBE_FRPC_VERSION}: ${keys.length} keys (${keys.join(', ')})`);
    } catch (error) {
      configError = (error as Error).message;
      console.log(`[probe] platform config unavailable: ${configError}`);
    }

    if (configPath && entry.url) {
      const log = path.join(checkpoint, 'upstream-frpc.log');
      client = spawn(options.frpc, [ '-c', configPath ], {
        stdio: [ 'ignore', 'pipe', 'pipe' ],
      });
      const chunks: string[] = [];
      client.stdout?.on('data', (data: Buffer) => chunks.push(data.toString()));
      client.stderr?.on('data', (data: Buffer) => chunks.push(data.toString()));
      const exitCode = await new Promise<string>((resolve) => {
        client?.once('exit', (code) => resolve(`exited ${code}`));
        client?.once('error', (error) => resolve(`spawn failed: ${error.message}`));
        setTimeout(() => resolve('running'), 3_000);
      });
      const probe = exitCode === 'running'
        ? await probeEntry(entry.url, marker, options.timeoutMs)
        : { ok: false, observed: exitCode };
      writeFileSync(log, chunks.join(''));
      results.push({
        client: `upstream frpc ${PROBE_FRPC_VERSION}`,
        config: 'platform-generated',
        reachable: probe.ok,
        observed: probe.observed,
        process: exitCode,
      });
      console.log(`[probe] upstream frpc: ${probe.ok ? 'REACHABLE' : 'unreachable'} · ${probe.observed}`);
      stop(client);
      client = undefined;
    } else {
      results.push({
        client: `upstream frpc ${PROBE_FRPC_VERSION}`,
        config: configError ? 'unavailable' : 'platform-generated',
        reachable: false,
        observed: configError ?? entry.reason ?? 'no entry to probe',
      });
    }

    const verdict = results.some((result) => result.reachable === true)
      ? 'upstream frpc drove a real SakuraFrp tunnel'
      : 'upstream frpc could not be proven against this tunnel';
    writeFileSync(path.join(checkpoint, 'evidence.json'), JSON.stringify({
      kind: 'sakura-client-compatibility',
      ranAt: new Date().toISOString(),
      tunnel: {
        id: tunnel.id,
        name: tunnel.name,
        type: tunnel.type,
        node: tunnel.node,
        local: `${localHost}:${localPort}`,
        remote: tunnel.remote,
      },
      credential: fingerprint(accessKey),
      entry: entry.url ?? `unknown: ${entry.reason}`,
      results,
      verdict,
    }, null, 2));
    console.log(`[probe] verdict: ${verdict}`);
    console.log(`[probe] evidence: ${path.relative(process.cwd(), checkpoint)}/evidence.json`);
    if (!results.some((result) => result.reachable === true)) {
      process.exitCode = 1;
    }
  } finally {
    if (client) stop(client);
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // A missing tunnel or key is an operator state, not a crash: say so once, without a stack.
    console.error(`[probe] ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
