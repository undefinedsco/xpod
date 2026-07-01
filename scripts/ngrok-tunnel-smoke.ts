import { createServer, type Server } from 'node:http';
import { NgrokTunnelProvider } from '../src/tunnel/NgrokTunnelProvider';
import type { AccessRoute } from '../src/edge/reachability';

interface CliOptions {
  dryRun: boolean;
  ngrokUrl?: string;
  ngrokAuthtoken?: string;
  ngrokBin?: string;
  ngrokAgentApiUrl?: string;
  localPort: number;
  localProtocol: 'http' | 'https';
  timeoutMs: number;
  testServer: boolean;
  path: string;
  canonicalUrl?: string;
}

const CAVEATS = [
  'ngrok is a user-owned user-tunnel provider; Xpod Cloud must not store the ngrok authtoken or proxy the data plane by default.',
  'free ngrok dev domains are not canonical Solid browser origins; use them for native/debug acceptance unless the ngrok account owns the canonical custom domain.',
  'formal Solid browser acceptance requires the browser URL to remain the canonical SP domain and the tunnel provider to serve that Host/SNI.',
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    url: options.ngrokUrl,
    ngrokPath: options.ngrokBin,
    agentApiUrl: options.ngrokAgentApiUrl,
    connectTimeoutMs: options.timeoutMs,
  });

  const config = await provider.setup({
    subdomain: 'ngrok-smoke',
    localPort: options.localPort,
    localProtocol: options.localProtocol,
  });

  if (options.dryRun) {
    writeJson({
      kind: 'ngrok-user-tunnel-smoke',
      dryRun: true,
      provider: provider.name,
      originUrl: config.originUrl,
      route: buildRoute(config.endpoint || options.ngrokUrl || '', config.originUrl ?? '', options.canonicalUrl),
      caveats: CAVEATS,
    });
    return;
  }

  let server: Server | undefined;
  if (options.testServer) {
    const started = await startTestServer(options.localPort);
    server = started.server;
  }

  try {
    await provider.start(config);
    const endpoint = provider.getEndpoint();
    if (!endpoint) {
      throw new Error('ngrok did not expose an endpoint');
    }

    const target = new URL(options.path, endpoint).toString();
    const probe = await fetchUntilOk(target, options.timeoutMs);
    const smokeOk = probe.ok;

    writeJson({
      kind: 'ngrok-user-tunnel-smoke',
      dryRun: false,
      smokeOk,
      provider: provider.name,
      endpoint,
      originUrl: config.originUrl,
      route: buildRoute(endpoint, config.originUrl ?? '', options.canonicalUrl),
      status: probe.status,
      attempts: probe.attempts,
      bodyPreview: probe.body.slice(0, 200),
      tunnelStatus: provider.getStatus(),
      caveats: CAVEATS,
    });

    if (!smokeOk) {
      process.exitCode = 1;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const blocker = classifyAcceptanceBlocker(errorMessage, provider.getStatus().error);
    writeJson({
      kind: 'ngrok-user-tunnel-smoke',
      dryRun: false,
      smokeOk: false,
      provider: provider.name,
      originUrl: config.originUrl,
      route: buildRoute(provider.getEndpoint() ?? config.endpoint, config.originUrl ?? '', options.canonicalUrl),
      error: errorMessage,
      ...(blocker ? {
        blockedBy: blocker.blockedBy,
        nextAction: blocker.nextAction,
      } : {}),
      tunnelStatus: provider.getStatus(),
      caveats: CAVEATS,
    });
    process.exitCode = 1;
  } finally {
    await provider.stop().catch(() => undefined);
    if (server) {
      await closeServer(server).catch(() => undefined);
    }
  }
}

function buildRoute(endpoint: string, originUrl: string, canonicalUrl?: string): AccessRoute {
  const targetUrl = normalizeUrl(endpoint) ?? endpoint;
  return {
    id: 'ngrok-user-tunnel',
    nodeId: 'ngrok-smoke',
    canonicalUrl: canonicalUrl ?? 'about:blank',
    kind: 'user-tunnel',
    targetUrl,
    priority: 50,
    requiresManagedClient: false,
    visibility: 'public',
    health: targetUrl ? 'healthy' : 'unknown',
    metadata: {
      provider: 'ngrok',
      originUrl,
    },
  };
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    if (key === 'dry-run' || key === 'test-server') {
      flags.add(key);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  return {
    dryRun: flags.has('dry-run'),
    testServer: flags.has('test-server'),
    ngrokUrl: values.get('ngrok-url') ?? process.env.NGROK_URL,
    ngrokAuthtoken: values.get('ngrok-authtoken') ?? process.env.NGROK_AUTHTOKEN,
    ngrokBin: values.get('ngrok-bin') ?? process.env.NGROK_BIN,
    ngrokAgentApiUrl: values.get('ngrok-agent-api-url') ?? process.env.NGROK_AGENT_API_URL,
    localPort: readPositiveInt(values.get('local-port') ?? process.env.NGROK_LOCAL_PORT ?? process.env.CSS_PORT) ?? 3000,
    localProtocol: values.get('local-protocol') === 'https' ? 'https' : 'http',
    timeoutMs: readPositiveInt(values.get('timeout-ms')) ?? 30_000,
    path: values.get('path') ?? '/__xpod_ngrok_smoke',
    canonicalUrl: normalizeUrl(values.get('canonical-url')),
  };
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return undefined;
  }
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface ProbeResult {
  ok: boolean;
  status: number;
  body: string;
  attempts: number;
}

async function fetchUntilOk(target: string, timeoutMs: number): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastResponse: ProbeResult | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(5_000, remainingMs));

    try {
      const response = await fetch(target, { method: 'GET', signal: controller.signal });
      const body = await response.text().catch(() => '');
      const result = {
        ok: response.ok,
        status: response.status,
        body,
        attempts,
      };
      if (result.ok) {
        return result;
      }
      lastResponse = result;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }

    const delayMs = Math.min(500, Math.max(25, deadline - Date.now()));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (lastResponse) {
    return { ...lastResponse, attempts };
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
  throw new Error(`ngrok endpoint was not reachable before timeout: ${reason}`);
}

function classifyAcceptanceBlocker(
  errorMessage: string,
  tunnelError?: string,
): { blockedBy: 'ngrok-auth'; nextAction: string } | undefined {
  const combined = `${errorMessage}\n${tunnelError ?? ''}`;
  if (!combined.includes('ERR_NGROK_4018')) {
    return undefined;
  }
  return {
    blockedBy: 'ngrok-auth',
    nextAction: 'Configure a user-owned ngrok credential with `ngrok config add-authtoken <token>` or set `NGROK_AUTHTOKEN`, then rerun this smoke command.',
  };
}

async function startTestServer(port: number): Promise<{ server: Server }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/__xpod_ngrok_smoke')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, provider: 'ngrok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

void main().catch((error) => {
  writeJson({
    kind: 'ngrok-user-tunnel-smoke',
    dryRun: false,
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    caveats: CAVEATS,
  });
  process.exitCode = 1;
});
