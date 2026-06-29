import { createServer, type Server } from 'node:http';
import { NgrokTunnelProvider } from '../src/tunnel/NgrokTunnelProvider';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';
import { setupAccount, loginWithClientCredentials } from '../tests/integration/helpers/solidAccount';

interface CliOptions {
  dryRun: boolean;
  ngrokUrl?: string;
  ngrokAuthtoken?: string;
  ngrokBin?: string;
  timeoutMs: number;
}

interface FetchProbe {
  ok: boolean;
  status: number;
  body: string;
  attempts: number;
}

const CAVEATS = [
  'This smoke starts a real local Xpod runtime and performs authenticated Pod PUT/GET/DELETE through the ngrok public endpoint.',
  'The ngrok endpoint is used as the temporary Solid base URL for this acceptance run.',
  'This proves ngrok public data-plane Pod read/write, but not canonical node-*.undefineds.co browser/Inrupt SDK routing unless the tunnel owns that canonical Host/SNI.',
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    const endpoint = normalizeEndpoint(options.ngrokUrl);
    writeJson({
      kind: 'ngrok-pod-readwrite-smoke',
      dryRun: true,
      endpoint: endpoint ?? 'auto-discover-from-ngrok-agent',
      steps: [
        'start local xpod runtime with ngrok endpoint as CSS_BASE_URL',
        'start ngrok tunnel to local xpod gateway',
        'GET /service/status through public endpoint',
        'create account, pod, and client credentials through public endpoint',
        'PUT/GET/DELETE a text resource through public endpoint',
      ],
      caveats: CAVEATS,
    });
    return;
  }

  const endpoint = await resolveEndpoint(options);
  let runtime: XpodRuntimeHandle | undefined;
  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    url: endpoint,
    ngrokPath: options.ngrokBin,
    connectTimeoutMs: options.timeoutMs,
  });

  const result: Record<string, unknown> = {
    kind: 'ngrok-pod-readwrite-smoke',
    dryRun: false,
    endpoint,
    stages: [],
    caveats: CAVEATS,
  };

  try {
    const endpointHost = new URL(endpoint).host;
    runtime = await startXpodRuntime({
      mode: 'local',
      transport: 'port',
      open: false,
      apiOpen: false,
      baseUrl: endpoint,
      env: {
        CSS_ALLOWED_HOSTS: `${endpointHost},localhost,127.0.0.1`,
        CSS_LOGGING_LEVEL: 'warn',
        CSS_REDIS_CLIENT: undefined,
        CSS_REDIS_USERNAME: undefined,
        CSS_REDIS_PASSWORD: undefined,
      },
    });

    const localPort = runtime.ports.gateway;
    if (!localPort) {
      throw new Error('xpod gateway port was not allocated');
    }

    const localGateway = `http://127.0.0.1:${localPort}/`;
    await fetchUntilOk(new URL('/service/status', localGateway).toString(), options.timeoutMs);
    pushStage(result, 'xpod-started');
    result.localGateway = localGateway;
    result.localPort = localPort;

    const tunnelConfig = await provider.setup({
      subdomain: 'ngrok-pod-readwrite-smoke',
      localPort,
      localProtocol: 'http',
    });
    await provider.start(tunnelConfig);
    pushStage(result, 'ngrok-started');
    result.tunnelStatus = provider.getStatus();

    const actualEndpoint = provider.getEndpoint();
    if (actualEndpoint && actualEndpoint !== endpoint) {
      throw new Error(`ngrok endpoint changed: expected ${endpoint}, got ${actualEndpoint}`);
    }

    const statusUrl = new URL('/service/status', endpoint).toString();
    const statusProbe = await fetchUntilOk(statusUrl, options.timeoutMs, {
      headers: { Accept: 'application/json' },
    });
    result.statusCheck = {
      url: statusUrl,
      status: statusProbe.status,
      attempts: statusProbe.attempts,
      bodyPreview: statusProbe.body.slice(0, 200),
    };
    pushStage(result, 'public-status-ok');

    const account = await setupAccount(stripTrailingSlash(endpoint), 'ngrokrw');
    if (!account) {
      throw new Error('setupAccount returned null');
    }
    result.account = {
      webId: account.webId,
      podUrl: account.podUrl,
      issuer: account.issuer,
      clientIdPrefix: account.clientId.slice(0, 12),
    };
    pushStage(result, 'account-pod-created');

    const session = await loginWithClientCredentials(account);
    result.session = {
      isLoggedIn: session.info.isLoggedIn,
      webId: session.info.webId,
    };
    if (!session.info.isLoggedIn) {
      throw new Error('client-credentials session is not logged in');
    }
    pushStage(result, 'client-credentials-login-ok');

    const body = `ngrok pod readwrite smoke ${Date.now()}`;
    const resourceUrl = new URL(`ngrok-smoke-${Date.now()}.txt`, account.podUrl).toString();
    const writeRes = await session.fetch(resourceUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
    result.write = {
      url: resourceUrl,
      status: writeRes.status,
      bodyPreview: (await writeRes.text().catch(() => '')).slice(0, 200),
    };
    if (![200, 201, 204].includes(writeRes.status)) {
      throw new Error(`public pod write failed: ${writeRes.status}`);
    }
    pushStage(result, 'public-write-ok');

    const readRes = await session.fetch(resourceUrl, { headers: { Accept: 'text/plain' } });
    const readBody = await readRes.text().catch(() => '');
    result.read = {
      status: readRes.status,
      body: readBody,
    };
    if (!readRes.ok || readBody !== body) {
      throw new Error(`public pod read mismatch: status=${readRes.status} body=${JSON.stringify(readBody)}`);
    }
    pushStage(result, 'public-read-ok');

    const deleteRes = await session.fetch(resourceUrl, { method: 'DELETE' });
    result.delete = { status: deleteRes.status };
    await session.logout().catch(() => undefined);

    result.smokeOk = true;
  } catch (error) {
    result.smokeOk = false;
    result.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await provider.stop().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
  }

  writeJson(result);
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
    if (key === 'dry-run') {
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
    ngrokUrl: values.get('ngrok-url') ?? process.env.NGROK_URL,
    ngrokAuthtoken: values.get('ngrok-authtoken') ?? process.env.NGROK_AUTHTOKEN,
    ngrokBin: values.get('ngrok-bin') ?? process.env.NGROK_BIN,
    timeoutMs: readPositiveInt(values.get('timeout-ms')) ?? 45_000,
  };
}

async function resolveEndpoint(options: CliOptions): Promise<string> {
  const configured = normalizeEndpoint(options.ngrokUrl);
  if (configured) {
    return configured;
  }

  const probe = await startProbeServer();
  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    ngrokPath: options.ngrokBin,
    connectTimeoutMs: options.timeoutMs,
  });

  try {
    const config = await provider.setup({
      subdomain: 'ngrok-pod-readwrite-discover',
      localPort: probe.port,
      localProtocol: 'http',
    });
    await provider.start(config);
    const endpoint = normalizeEndpoint(provider.getEndpoint());
    if (!endpoint) {
      throw new Error('ngrok did not expose an endpoint');
    }
    return endpoint;
  } finally {
    await provider.stop().catch(() => undefined);
    await closeServer(probe.server).catch(() => undefined);
  }
}

async function fetchUntilOk(
  target: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<FetchProbe> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastResponse: FetchProbe | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    attempts += 1;
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeout = setTimeout(() => controller.abort(), Math.min(5_000, remainingMs));

    try {
      const response = await fetch(target, {
        ...init,
        signal: controller.signal,
      });
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
  throw new Error(`endpoint was not reachable before timeout: ${reason}`);
}

async function startProbeServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to allocate probe server port');
  }
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function pushStage(result: Record<string, unknown>, stage: string): void {
  (result.stages as string[]).push(stage);
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

void main().catch((error) => {
  writeJson({
    kind: 'ngrok-pod-readwrite-smoke',
    dryRun: false,
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    caveats: CAVEATS,
  });
  process.exitCode = 1;
});
