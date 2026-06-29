import { chromium, type Browser } from 'playwright';
import { NgrokTunnelProvider } from '../src/tunnel/NgrokTunnelProvider';
import { startXpodRuntime, type XpodRuntimeHandle } from '../src/runtime/XpodRuntime';

interface CliOptions {
  dryRun: boolean;
  headed: boolean;
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
  'This smoke verifies a real Chromium browser context against the ngrok public endpoint.',
  'It uses the ngrok endpoint as the temporary same-origin Solid base URL for account, token, and Pod resource calls.',
  'For free ngrok dev domains, browser requests send ngrok-skip-browser-warning to bypass the ngrok interstitial warning page.',
  'It intentionally uses client credentials inside the browser only as a smoke-test shortcut; production browser login should use OIDC redirect/PKCE.',
  'It does not prove canonical node-*.undefineds.co browser/Inrupt SDK routing unless the tunnel owns that canonical Host/SNI.',
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    writeJson({
      kind: 'ngrok-browser-pod-smoke',
      dryRun: true,
      endpoint: normalizeEndpoint(options.ngrokUrl) ?? 'auto-discover-from-ngrok-agent',
      browser: 'chromium',
      steps: [
        'start local xpod runtime with ngrok endpoint as CSS_BASE_URL',
        'start ngrok tunnel to local xpod gateway',
        'open the public endpoint in Chromium',
        'from browser JavaScript create account, pod, and client credentials',
        'from browser JavaScript PUT/GET/DELETE a Pod text resource',
      ],
      caveats: CAVEATS,
    });
    return;
  }

  const endpoint = await resolveEndpoint(options);
  let runtime: XpodRuntimeHandle | undefined;
  let browser: Browser | undefined;
  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    url: endpoint,
    ngrokPath: options.ngrokBin,
    connectTimeoutMs: options.timeoutMs,
  });

  const result: Record<string, unknown> = {
    kind: 'ngrok-browser-pod-smoke',
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
      subdomain: 'ngrok-browser-pod-smoke',
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

    browser = await chromium.launch({ headless: !options.headed });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'ngrok-skip-browser-warning': 'true',
    });
    await page.goto(statusUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    pushStage(result, 'browser-opened-public-endpoint');

    const browserResult = await page.evaluate(async(baseUrl) => {
      const stages: string[] = [];
      const ngrokHeaders = {
        'ngrok-skip-browser-warning': 'true',
      };
      const jsonHeaders = {
        ...ngrokHeaders,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      const toUrl = (path: string): string => new URL(path, baseUrl).toString();

      async function textOf(response: Response): Promise<string> {
        return await response.text().catch(() => '');
      }

      const statusResponse = await fetch(toUrl('/service/status'), {
        headers: { ...ngrokHeaders, Accept: 'application/json' },
      });
      const statusBody = await textOf(statusResponse);
      if (!statusResponse.ok) {
        throw new Error(`browser status failed: ${statusResponse.status} ${statusBody.slice(0, 200)}`);
      }
      stages.push('browser-status-ok');

      const accountResponse = await fetch(toUrl('/.account/account/'), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({}),
      });
      const accountBody = await textOf(accountResponse);
      if (!accountResponse.ok) {
        throw new Error(`browser account create failed: ${accountResponse.status} ${accountBody.slice(0, 200)}`);
      }
      const accountData = JSON.parse(accountBody) as { authorization?: string };
      if (!accountData.authorization) {
        throw new Error('browser account create response missing authorization');
      }
      stages.push('browser-account-created');

      const controlsResponse = await fetch(toUrl('/.account/'), {
        headers: {
          ...ngrokHeaders,
          Accept: 'application/json',
          Authorization: `CSS-Account-Token ${accountData.authorization}`,
        },
      });
      const controlsBody = await textOf(controlsResponse);
      if (!controlsResponse.ok) {
        throw new Error(`browser controls failed: ${controlsResponse.status} ${controlsBody.slice(0, 200)}`);
      }
      const controls = JSON.parse(controlsBody) as {
        controls?: {
          password?: {
            create?: string;
          };
          account?: {
            pod?: string;
            clientCredentials?: string;
          };
        };
      };
      const podCreateUrl = controls.controls?.account?.pod;
      const clientCredentialsUrl = controls.controls?.account?.clientCredentials;
      if (!podCreateUrl || !clientCredentialsUrl) {
        throw new Error(`browser controls missing pod/clientCredentials: ${controlsBody.slice(0, 200)}`);
      }

      const passwordCreateUrl = controls.controls?.password?.create;
      if (passwordCreateUrl) {
        const passwordResponse = await fetch(passwordCreateUrl, {
          method: 'POST',
          headers: {
            ...jsonHeaders,
            Authorization: `CSS-Account-Token ${accountData.authorization}`,
          },
          body: JSON.stringify({
            email: `browser-ngrok-${Date.now()}@test.local`,
            password: `BrowserNgrok${Date.now()}!`,
          }),
        });
        const passwordBody = await textOf(passwordResponse);
        if (!passwordResponse.ok) {
          throw new Error(`browser password login create failed: ${passwordResponse.status} ${passwordBody.slice(0, 200)}`);
        }
        stages.push('browser-password-login-created');
      }

      const podName = `browser-ngrok-${Date.now().toString(36)}`;
      const podResponse = await fetch(podCreateUrl, {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Authorization: `CSS-Account-Token ${accountData.authorization}`,
        },
        body: JSON.stringify({ name: podName }),
      });
      const podBody = await textOf(podResponse);
      if (!podResponse.ok) {
        throw new Error(`browser pod create failed: ${podResponse.status} ${podBody.slice(0, 200)}`);
      }
      const podData = JSON.parse(podBody) as { webId?: string; pod?: string };
      const webId = podData.webId;
      const podUrl = podData.pod ?? new URL(`/${podName}/`, baseUrl).toString();
      if (!webId) {
        throw new Error(`browser pod create missing webId: ${podBody.slice(0, 200)}`);
      }
      stages.push('browser-pod-created');

      const credentialsResponse = await fetch(clientCredentialsUrl, {
        method: 'POST',
        headers: {
          ...jsonHeaders,
          Authorization: `CSS-Account-Token ${accountData.authorization}`,
        },
        body: JSON.stringify({
          name: `browser-ngrok-${Date.now()}`,
          webId,
        }),
      });
      const credentialsBody = await textOf(credentialsResponse);
      if (!credentialsResponse.ok) {
        throw new Error(`browser credentials failed: ${credentialsResponse.status} ${credentialsBody.slice(0, 200)}`);
      }
      const credentials = JSON.parse(credentialsBody) as { id?: string; secret?: string };
      if (!credentials.id || !credentials.secret) {
        throw new Error(`browser credentials response missing fields: ${credentialsBody.slice(0, 200)}`);
      }
      stages.push('browser-client-credentials-created');

      const tokenResponse = await fetch(toUrl('/.oidc/token'), {
        method: 'POST',
        headers: {
          ...ngrokHeaders,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credentials.id,
          client_secret: credentials.secret,
        }),
      });
      const tokenBody = await textOf(tokenResponse);
      if (!tokenResponse.ok) {
        throw new Error(`browser token failed: ${tokenResponse.status} ${tokenBody.slice(0, 200)}`);
      }
      const token = JSON.parse(tokenBody) as {
        access_token?: string;
        token_type?: string;
      };
      if (!token.access_token) {
        throw new Error(`browser token response missing access_token: ${tokenBody.slice(0, 200)}`);
      }
      const tokenType = token.token_type?.toLowerCase() === 'dpop' ? 'DPoP' : 'Bearer';
      stages.push('browser-token-ok');

      const body = `ngrok browser pod smoke ${Date.now()}`;
      const resourceUrl = new URL(`browser-ngrok-smoke-${Date.now()}.txt`, podUrl).toString();
      const authHeaders = {
        ...ngrokHeaders,
        Authorization: `${tokenType} ${token.access_token}`,
      };
      const writeResponse = await fetch(resourceUrl, {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'text/plain',
        },
        body,
      });
      const writeBody = await textOf(writeResponse);
      if (![200, 201, 204].includes(writeResponse.status)) {
        throw new Error(`browser write failed: ${writeResponse.status} ${writeBody.slice(0, 200)}`);
      }
      stages.push('browser-write-ok');

      const readResponse = await fetch(resourceUrl, {
        headers: {
          ...authHeaders,
          Accept: 'text/plain',
        },
      });
      const readBody = await textOf(readResponse);
      if (!readResponse.ok || readBody !== body) {
        throw new Error(`browser read mismatch: status=${readResponse.status} body=${JSON.stringify(readBody)}`);
      }
      stages.push('browser-read-ok');

      const deleteResponse = await fetch(resourceUrl, {
        method: 'DELETE',
        headers: authHeaders,
      });

      return {
        stages,
        webId,
        podUrl,
        resourceUrl,
        write: { status: writeResponse.status },
        read: { status: readResponse.status, body: readBody },
        delete: { status: deleteResponse.status },
      };
    }, endpoint);

    result.browser = browserResult;
    for (const stage of browserResult.stages) {
      pushStage(result, stage);
    }
    result.smokeOk = true;
  } catch (error) {
    result.smokeOk = false;
    result.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
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
    if (key === 'dry-run' || key === 'headed') {
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
    headed: flags.has('headed'),
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

  const provider = new NgrokTunnelProvider({
    authtoken: options.ngrokAuthtoken,
    ngrokPath: options.ngrokBin,
    connectTimeoutMs: options.timeoutMs,
  });
  const probeServer = await startProbeServer();

  try {
    const config = await provider.setup({
      subdomain: 'ngrok-browser-pod-discover',
      localPort: probeServer.port,
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
    await closeServer(probeServer.server).catch(() => undefined);
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

async function startProbeServer(): Promise<{ server: import('node:http').Server; port: number }> {
  const { createServer } = await import('node:http');
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

function closeServer(server: import('node:http').Server): Promise<void> {
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
    kind: 'ngrok-browser-pod-smoke',
    dryRun: false,
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    caveats: CAVEATS,
  });
  process.exitCode = 1;
});
