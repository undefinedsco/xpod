import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { createSolidAccessRouteFetch } from '@undefineds.co/solid-sdk/access-route';
import { AutoTunnelProvider, type AutoTunnelCandidate } from '../src/tunnel/AutoTunnelProvider';
import { LocalTunnelProvider } from '../src/tunnel/LocalTunnelProvider';
import { NgrokTunnelProvider } from '../src/tunnel/NgrokTunnelProvider';
import { SakuraFrpTunnelProvider } from '../src/tunnel/SakuraFrpTunnelProvider';
import type { TunnelConfig, TunnelProvider, TunnelSetupOptions, TunnelStatus } from '../src/tunnel/TunnelProvider';
import type { XpodRuntimeHandle } from '../src/runtime/XpodRuntime';
import { standaloneRuntimeEnv } from './lib/standalone-runtime-env';

interface CliOptions {
  dryRun: boolean;
  headed: boolean;
  localOnly: boolean;
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

interface PasswordAccount {
  email: string;
  password: string;
  webId: string;
  podUrl: string;
  podName: string;
}

interface OidcObservations {
  authCodeChallenge: boolean;
  authCodeChallengeMethodS256: boolean;
  redirectCode: boolean;
  tokenGrantAuthorizationCode: boolean;
  tokenCodeVerifier: boolean;
  tokenRequestUrl?: string;
}

const STORAGE_PATH = '.data/inrupt-smoke/probe.ttl#this';

/**
 * Tunnel candidates, best first: the providers the operator configured (they can
 * serve a canonical hostname) and then a credential-free Cloudflare quick tunnel,
 * so a run still gets a real public entry when every configured provider is
 * blocked by the network it is on.
 */
function buildTunnelCandidates(options: CliOptions, localPort: number): AutoTunnelCandidate[] {
  void localPort;
  const candidates: AutoTunnelCandidate[] = [];
  const ngrokToken = options.ngrokAuthtoken ?? process.env.NGROK_AUTHTOKEN;
  const ngrokUrl = options.ngrokUrl ?? process.env.NGROK_URL;
  if (ngrokToken || ngrokUrl) {
    candidates.push({
      id: 'ngrok',
      provider: new NgrokTunnelProvider({
        authtoken: ngrokToken,
        url: ngrokUrl,
        ngrokPath: options.ngrokBin,
      }),
    });
  }
  const cloudflareToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  if (cloudflareToken) {
    candidates.push({
      id: 'cloudflare',
      provider: new LocalTunnelProvider({
        tunnelToken: cloudflareToken,
        publicUrl: process.env.CLOUDFLARE_TUNNEL_URL ?? process.env.XPOD_TUNNEL_PUBLIC_URL,
      }),
    });
  }
  const sakuraToken = process.env.SAKURA_TUNNEL_TOKEN ?? process.env.SAKURA_TOKEN;
  if (sakuraToken) {
    candidates.push({
      id: 'sakura_frp',
      provider: new SakuraFrpTunnelProvider({
        token: sakuraToken,
        publicUrl: process.env.SAKURA_TUNNEL_URL,
      }),
    });
  }
  candidates.push({ id: 'cloudflare-quick', provider: new CloudflaredQuickTunnelProvider() });
  return candidates;
}

/**
 * Loopback ports the runtime can take over once the tunnel points at them.
 *
 * They are picked below the OS ephemeral range on purpose: the gateway, CSS and
 * API ports are allocated as a block and a port the kernel may hand to any other
 * socket in the meantime would make the runtime fail to bind what the tunnel is
 * already forwarding to.
 */
async function reserveLoopbackPorts(count = 3): Promise<number[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = 40_000 + Math.floor(Math.random() * 8_000);
    const servers: Array<ReturnType<typeof createServer>> = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(base + index, '127.0.0.1', resolve);
        });
        servers.push(server);
      }
      return servers.map((server) => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('reserved port has no address');
        }
        return address.port;
      });
    } catch {
      // Another process owns part of this block; try the next one.
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve());
      })));
    }
  }
  throw new Error('could not reserve consecutive loopback ports for the tunnel origin');
}

/**
 * A Cloudflare quick tunnel: a real third-party edge with no account, which is
 * what makes the smoke runnable where a configured provider is blocked. The
 * hostname is random per run and belongs to Cloudflare, so it is an access route
 * and never a canonical identity.
 */
class CloudflaredQuickTunnelProvider implements TunnelProvider {
  public readonly name = 'cloudflare-quick';
  private child?: ChildProcess;
  private endpoint?: string;
  private status: TunnelStatus = { running: false, connected: false, stage: 'stopped' };

  public constructor(private readonly cloudflaredPath = process.env.CLOUDFLARED_BIN ?? 'cloudflared') {}

  public async setup(options: TunnelSetupOptions): Promise<TunnelConfig> {
    return {
      subdomain: options.subdomain,
      provider: 'cloudflare',
      endpoint: '',
      originUrl: `${options.localProtocol ?? 'http'}://127.0.0.1:${options.localPort}`,
    };
  }

  public async start(config: TunnelConfig): Promise<void> {
    const origin = config.originUrl ?? 'http://127.0.0.1:8080';
    this.status = { running: true, connected: false, stage: 'process-started' };
    this.child = spawn(this.cloudflaredPath, [
      'tunnel',
      '--no-autoupdate',
      '--url', origin,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const onOutput = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu);
      if (!match || this.endpoint) {
        return;
      }
      this.endpoint = `${match[0]}/`;
      // The edge needs a moment before the hostname answers; readiness here means
      // the connector registered the entry, which the caller then probes.
      this.status = { running: true, connected: true, stage: 'proxy-ready', endpoint: this.endpoint };
    };
    this.child.stdout?.on('data', onOutput);
    this.child.stderr?.on('data', onOutput);
    this.child.on('exit', (code) => {
      this.child = undefined;
      if (!this.endpoint) {
        this.status = { running: false, connected: false, stage: 'failed', error: `cloudflared exited with code ${code}` };
      }
    });
    this.child.on('error', (error) => {
      this.status = { running: false, connected: false, stage: 'failed', error: `cloudflared could not start: ${error.message}` };
    });
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.status = { running: false, connected: false, stage: 'stopped' };
  }

  public getStatus(): TunnelStatus {
    return this.status;
  }

  public getEndpoint(): string | undefined {
    return this.endpoint;
  }

  public async cleanup(): Promise<void> {
    await this.stop();
  }
}

/** A local-only run owns its runtime state so nothing managed leaks into it. */
const LOCAL_ONLY_RUNTIME_ROOT = '.test-data/inrupt-smoke-standalone';

/** Where a failed browser stage leaves its screenshot for inspection. */
const FAILURE_SCREENSHOT_PATH = '.test-data/inrupt-smoke-failure.png';

const PROVES = [
  'Inrupt browser SDK starts an authorization-code redirect flow with PKCE code_challenge.',
  'The browser receives an authorization code redirect back to /app/inrupt-smoke.html.',
  'The Inrupt SDK exchanges the code at the token endpoint with grant_type=authorization_code and code_verifier.',
  'session.info.isLoggedIn is true after handleIncomingRedirect.',
  'session.fetch can read the WebID profile and drizzle-solid can write/read/delete a Pod RDF resource.',
];

const CAVEATS = [
  'This smoke verifies formal Inrupt OIDC redirect/PKCE in a real Chromium browser context.',
  'It can run against a local loopback origin, or against an ngrok endpoint used as the temporary same-origin Solid issuer and SP base URL.',
  'For free ngrok dev domains, browser requests send ngrok-skip-browser-warning to bypass the ngrok interstitial warning page.',
  'It does not use the client credentials shortcut for browser login.',
  'It does not prove canonical node-*.undefineds.co browser routing unless the tunnel provider serves that canonical Host/SNI.',
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.dryRun) {
    const localSteps = [
      'start local xpod runtime with a loopback CSS_BASE_URL',
      'create a test account, password login, and pod through the loopback origin',
      'open /app/inrupt-smoke.html in Chromium',
      'click the Inrupt login button',
      'submit the CSS password login form in the redirected OIDC flow',
      'observe PKCE code_challenge, authorization code redirect, and token code_verifier exchange',
      'run Inrupt session discovery and drizzle-solid Pod read/write/delete from the browser',
      'register the owner interface key, then read the Pod with no caller credential and confirm the internal route serves nothing',
    ];
    const tunnelSteps = [
      'pick whichever configured tunnel provider becomes proxy-ready, else a credential-free cloudflared quick tunnel',
      'start the local xpod runtime with the tunnel entry as its canonical origin',
      'create a test account, password login, and pod through the public entry',
      ...localSteps.slice(2),
    ];
    writeJson({
      kind: 'ngrok-inrupt-oidc-smoke',
      dryRun: true,
      // An explicit entry is a decision the operator already made; otherwise the run picks
      // whichever provider becomes proxy-ready.
      endpoint: options.localOnly
        ? 'auto-local-loopback-origin'
        : normalizeEndpoint(options.ngrokUrl) ?? 'auto-selected-tunnel-entry',
      browser: 'chromium',
      steps: options.localOnly ? localSteps : tunnelSteps,
      proves: PROVES,
      caveats: options.localOnly ? [...CAVEATS, 'Local-only mode proves OIDC/PKCE on loopback, not public tunnel reachability.'] : CAVEATS,
    });
    return;
  }

  const [playwright, runtimeModule] = await Promise.all([
    import('playwright'),
    import('../src/runtime/XpodRuntime'),
  ]);
  const { chromium } = playwright;
  const { startXpodRuntime } = runtimeModule;

  let endpoint = '';
  let tunnelPort: number | undefined;
  let runtime: XpodRuntimeHandle | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let provider: AutoTunnelProvider | undefined;

  const routeCalls: Array<{ url: string; status?: number; error?: string }> = [];
  const browserRouteCalls: Array<{ url: string; target?: string; status?: number; location?: string; error?: string }> = [];
  const directCalls: Array<{ url: string; cookie?: string }> = [];
  const cookieTrace: Array<{ url: string; setCookie: string[]; jar: string[] }> = [];
  const browserErrors: string[] = [];
  const result: Record<string, unknown> = {
    kind: 'ngrok-inrupt-oidc-smoke',
    dryRun: false,
    endpoint: options.localOnly ? 'pending-local-loopback-origin' : 'pending-tunnel',
    mode: options.localOnly ? 'local-only' : 'tunnel',
    stages: [],
    proves: PROVES,
    caveats: options.localOnly ? [...CAVEATS, 'Local-only mode proves OIDC/PKCE on loopback, not public tunnel reachability.'] : CAVEATS,
  };

  try {
    if (options.localOnly) {
      resetStandaloneRuntimeRoot();
      runtime = await startXpodRuntime({
        mode: 'local',
        transport: 'port',
        bindHost: 'localhost',
        open: false,
        apiOpen: false,
        runtimeRoot: LOCAL_ONLY_RUNTIME_ROOT,
        rootFilePath: `${LOCAL_ONLY_RUNTIME_ROOT}/data`,
        env: standaloneRuntimeEnv(),
      });
      endpoint = runtime.baseUrl;
      result.endpoint = endpoint;
    } else {
      // The tunnel comes first and the runtime follows it, because the tunnel host
      // is this runtime's canonical identity. Whichever provider can actually
      // reach its control plane wins - the operator configures credentials, not a
      // priority, and a blocked provider must not hold the run hostage.
      const [gatewayPort, cssPort, apiPort] = await reserveLoopbackPorts();
      tunnelPort = gatewayPort;
      provider = new AutoTunnelProvider({
        candidates: buildTunnelCandidates(options, tunnelPort),
        readinessTimeoutMs: Math.min(options.timeoutMs, 60_000),
      });
      const tunnelConfig = await provider.setup({
        subdomain: 'xpod-inrupt-oidc-smoke',
        localPort: tunnelPort,
        localProtocol: 'http',
      });
      await provider.start(tunnelConfig);
      endpoint = normalizeEndpoint(provider.getEndpoint()) ?? '';
      result.endpoint = endpoint || 'no-tunnel-entry';
      result.tunnel = {
        provider: provider.getActiveId(),
        attempts: provider.getAttempts(),
        status: provider.getStatus(),
      };
      if (!endpoint) {
        throw new Error(`no tunnel provider became ready: ${provider.getStatus().error ?? 'unknown reason'}`);
      }
      pushStage(result, 'tunnel-started');
      resetStandaloneRuntimeRoot();
      const endpointHost = new URL(endpoint).host;
      runtime = await startXpodRuntime({
        mode: 'local',
        transport: 'port',
        open: false,
        apiOpen: false,
        baseUrl: endpoint,
        gatewayPort,
        cssPort,
        apiPort,
        runtimeRoot: LOCAL_ONLY_RUNTIME_ROOT,
        rootFilePath: `${LOCAL_ONLY_RUNTIME_ROOT}/data`,
        env: {
          ...standaloneRuntimeEnv(),
          // The tunnel host is both where this runtime listens and the identity
          // its clients authenticate with. Saying so keeps the runtime from
          // registering with Cloud and adopting a different canonical URL.
          SOLID_OIDC_ISSUER: endpoint,
          CSS_ALLOWED_HOSTS: `${endpointHost},localhost,127.0.0.1`,
        },
      });
    }

    const localPort = runtime.ports.gateway;
    if (!localPort) {
      throw new Error('xpod gateway port was not allocated');
    }

    const localGateway = options.localOnly ? endpoint : `http://127.0.0.1:${localPort}/`;
    await fetchUntilOk(new URL('/service/status', localGateway).toString(), options.timeoutMs);
    pushStage(result, 'xpod-started');
    result.localGateway = localGateway;
    result.localPort = localPort;

    // A Local Pod keeps a canonical URL (its RDF identity) while the same machine
    // reaches it over the loopback access route. This smoke is such a client: it
    // configures the route set itself and then talks canonical URLs only.
    const runtimeStatus = await readRuntimeProvisionStatus(localGateway);
    result.canonicalOrigin = runtimeStatus.origin;
    result.canonicalOriginProbe = runtimeStatus;
    if (!runtimeStatus.origin) {
      // Falling back to an unrouted client would silently send canonical requests
      // to the public internet, which is exactly what this smoke must not do.
      throw new Error(`canonical origin could not be resolved from ${localGateway}: ${JSON.stringify(runtimeStatus)}`);
    }
    const canonicalOrigin = runtimeStatus.origin;
    const routeTransport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const record: { url: string; status?: number; error?: string } = { url };
      routeCalls.push(record);
      try {
        const response = await fetch(input as never, init);
        record.status = response.status;
        return response;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }) as typeof fetch;
    const routeFetch = createSolidAccessRouteFetch({
      fetch: routeTransport,
      routes: () => [{
        id: 'loopback',
        kind: 'loopback' as const,
        canonicalUrl: canonicalOrigin,
        targetUrl: localGateway,
        priority: 10,
        requiresManagedClient: true,
        visibility: 'local-only' as const,
        health: 'healthy' as const,
      }],
      allowLocalOnlyRoutes: true,
      managedClient: true,
      probe: () => true,
    });

    const statusUrl = new URL('/service/status', endpoint).toString();
    const statusProbe = await fetchUntilOk(statusUrl, options.timeoutMs, {
      headers: { Accept: 'application/json', 'ngrok-skip-browser-warning': 'true' },
    });
    result.statusCheck = {
      url: statusUrl,
      status: statusProbe.status,
      attempts: statusProbe.attempts,
      bodyPreview: statusProbe.body.slice(0, 200),
    };
    if (!statusProbe.ok) {
      throw new Error(`status endpoint failed: ${statusProbe.status} ${statusProbe.body.slice(0, 200)}`);
    }
    pushStage(result, options.localOnly ? 'loopback-status-ok' : 'public-status-ok');

    // Whichever identity provider this runtime authenticates with owns the
    // account: a managed Local runtime keeps its node registered with Cloud, so
    // the browser's login form talks to Cloud and a local-only account would be
    // rejected there.
    const cloudIssuer = managedIdentityIssuer(runtimeStatus, localGateway);
    result.identityProvider = cloudIssuer ?? new URL(endpoint).origin;
    const account = cloudIssuer
      ? await createManagedAccount({
          cloudIssuer,
          localGateway,
          ...(runtimeStatus.provisionCode ? { provisionCode: runtimeStatus.provisionCode } : {}),
        })
      : await createPasswordAccount(routeFetch, endpoint);
    result.provisioning = {
      mode: cloudIssuer ? 'cloud-account-local-pod' : 'local-account',
      podName: account.podName,
    };
    result.routeCalls = routeCalls;
    result.browserRouteCalls = browserRouteCalls;
    result.account = {
      email: account.email,
      webId: account.webId,
      podUrl: account.podUrl,
      podName: account.podName,
    };
    pushStage(result, 'account-password-pod-created');

    browser = await chromium.launch({ headless: !options.headed });
    context = await browser.newContext({
      extraHTTPHeaders: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    // Local-only mode is the one that needs interception: the page is served from
    // loopback while the Pod's canonical origin is elsewhere, and Playwright refuses
    // to switch a request's protocol. With a public entry the browser talks to the
    // canonical host directly, which is the path this mode exists to prove.
    result.browserAccess = options.localOnly ? 'canonical-over-loopback' : 'public-entry';
    await context.route('**/*', async(route) => {
      if (!options.localOnly) {
        const directHeaders = {
          ...directRequestHeaders(route),
          'ngrok-skip-browser-warning': 'true',
        };
        if (directCalls.length < 40) {
          directCalls.push({ url: route.request().url(), cookie: route.request().headers().cookie });
        }
        await route.continue({ headers: directHeaders });
        return;
      }
      const request = route.request();
      const headers = {
        ...request.headers(),
        'ngrok-skip-browser-warning': 'true',
      };
      const requestUrl = request.url();
      const target = canonicalRouteTarget(canonicalOrigin, localGateway, requestUrl);
      if (target) {
        // The browser keeps canonical https URLs while the request itself travels
        // over the loopback access route. Playwright refuses to switch a request's
        // protocol, so the access route answers here and the browser is handed that
        // response: the same rewrite the SDK performs, one layer further out.
        await fulfillFromAccessRoute(route, routeFetch, target, requestUrl, canonicalOrigin, headers, context!, browserRouteCalls, cookieTrace);
        return;
      }
      if (directCalls.length < 40) {
        directCalls.push({
          url: requestUrl,
          cookie: request.headers().cookie,
          userAgent: undefined,
        });
      }
      await route.continue({ headers });
    });

    const page = await context.newPage();
    // A page that renders nothing is only diagnosable with what the browser said.
    page.on('pageerror', (error) => {
      if (browserErrors.length < 20) browserErrors.push(`pageerror: ${error.message}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && browserErrors.length < 30) {
        browserErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });
    const observations = observeOidc(page);
    const verifierUrl = buildVerifierUrl(endpoint);
    result.verifierUrl = verifierUrl;

    await page.goto(verifierUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    pushStage(result, 'browser-opened-inrupt-verifier');

    await page.getByRole('button', { name: /login xpod/i }).click({ timeout: options.timeoutMs });
    pushStage(result, 'inrupt-login-clicked');

    await completeOidcLogin(page, account, endpoint, options.timeoutMs);
    pushStage(result, 'oidc-login-form-submitted');

    await waitForLoggedIn(page, options.timeoutMs);
    pushStage(result, 'inrupt-session-logged-in');

    if (!observations.authCodeChallenge || !observations.authCodeChallengeMethodS256) {
      throw new Error(`PKCE authorization request was not observed: ${JSON.stringify(observations)}`);
    }
    if (!observations.redirectCode) {
      throw new Error(`authorization code redirect was not observed: ${JSON.stringify(observations)}`);
    }
    if (!observations.tokenGrantAuthorizationCode || !observations.tokenCodeVerifier) {
      throw new Error(`PKCE token exchange was not observed: ${JSON.stringify(observations)}`);
    }
    result.oidc = observations;
    pushStage(result, 'pkce-observed');

    await clickAndWaitForReport(page, /check xpod discovery/i, (report) => Boolean(report.discovery?.ok), options.timeoutMs);
    pushStage(result, 'session-fetch-discovery-ok');

    const storageReport = await clickAndWaitForReport(page, /discover storage home/i, (report) => {
      return typeof report.storage?.storageUrl === 'string' && report.storage.storageUrl.length > 0;
    }, options.timeoutMs);
    pushStage(result, 'webid-storage-discovered');

    const drizzleReport = await clickAndWaitForReport(page, /drizzle read\/write\/delete/i, (report) => {
      return report.drizzleSolid?.ok === true;
    }, options.timeoutMs);
    pushStage(result, 'drizzle-solid-readwrite-ok');

    const interfaceKey = await verifyPodInterfaceKey({
      endpoint,
      identityBaseUrl: result.identityProvider as string,
      account,
    });
    result.podInterfaceKey = interfaceKey;
    if (interfaceKey.before !== 'unsupported/not_configured') {
      throw new Error(`expected no Pod access before the grant, got ${interfaceKey.before}`);
    }
    if (!interfaceKey.after.startsWith('available/')) {
      throw new Error(`expected the granted key to serve the Pod read, got ${interfaceKey.after}`);
    }
    if (interfaceKey.listed < 1) {
      throw new Error(`expected the caller key to list its own Pod record, got ${interfaceKey.listed}`);
    }
    pushStage(result, 'pod-interface-key-granted');

    result.browser = {
      session: drizzleReport.session,
      storage: storageReport.storage,
      drizzleSolid: drizzleReport.drizzleSolid,
    };
    result.smokeOk = true;
  } catch (error) {
    result.smokeOk = false;
    result.error = error instanceof Error ? error.message : String(error);
    result.routeCalls = routeCalls;
    result.browserRouteCalls = browserRouteCalls;
    result.directCalls = directCalls.slice(-25);
    result.cookieTrace = cookieTrace;
    result.browserErrors = browserErrors;
    // A failed browser stage is only diagnosable with what the page showed.
    const page = context?.pages()[0];
    if (page) {
      result.browserTitle = await page.title().catch(() => undefined);
      result.browserButtons = await page.getByRole('button').allTextContents().catch(() => []);
      result.browserText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1_000);
      await page.screenshot({ path: FAILURE_SCREENSHOT_PATH, fullPage: false }).catch(() => undefined);
      result.browserScreenshot = FAILURE_SCREENSHOT_PATH;
    }
    if (context) {
      result.browserUrl = context.pages()[0]?.url();
    }
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await provider?.stop().catch(() => undefined);
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
    if (key === 'dry-run' || key === 'headed' || key === 'local-only') {
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
    localOnly: flags.has('local-only'),
    ngrokUrl: values.get('ngrok-url') ?? process.env.NGROK_URL,
    ngrokAuthtoken: values.get('ngrok-authtoken') ?? process.env.NGROK_AUTHTOKEN,
    ngrokBin: values.get('ngrok-bin') ?? process.env.NGROK_BIN,
    timeoutMs: readPositiveInt(values.get('timeout-ms')) ?? 60_000,
  };
}

/**
 * The verifier app is served by this node, but the Inrupt client has to trust the
 * identity provider this node actually authenticates with: a managed Local
 * runtime delegates OIDC to Cloud, and a client that starts the flow locally
 * would leave its interaction where Cloud's consent page cannot see it.
 */
function buildVerifierUrl(endpoint: string): string {
  // The page reads the identity provider from the runtime it is served by; the entry point only
  // names which resource to probe.
  const url = new URL('/app/inrupt-smoke.html', endpoint);
  url.searchParams.set('storagePath', STORAGE_PATH);
  return url.toString();
}

function observeOidc(page: Page): OidcObservations {
  const observations: OidcObservations = {
    authCodeChallenge: false,
    authCodeChallengeMethodS256: false,
    redirectCode: false,
    tokenGrantAuthorizationCode: false,
    tokenCodeVerifier: false,
  };

  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.searchParams.has('code_challenge')) {
        observations.authCodeChallenge = true;
        observations.authCodeChallengeMethodS256 = url.searchParams.get('code_challenge_method') === 'S256';
      }
      if (url.pathname.endsWith('/.oidc/token') || url.pathname.includes('/.oidc/token')) {
        observations.tokenRequestUrl = url.toString();
        const body = request.postData() ?? '';
        const params = new URLSearchParams(body);
        observations.tokenGrantAuthorizationCode = params.get('grant_type') === 'authorization_code'
          || body.includes('grant_type=authorization_code');
        observations.tokenCodeVerifier = params.has('code_verifier') || body.includes('code_verifier=');
      }
    } catch {
      // Ignore non-URL request entries.
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }
    try {
      const url = new URL(frame.url());
      if (url.pathname === '/app/inrupt-smoke.html' && url.searchParams.has('code')) {
        observations.redirectCode = true;
      }
    } catch {
      // Ignore transient browser URLs.
    }
  });

  return observations;
}

async function completeOidcLogin(
  page: Page,
  account: PasswordAccount,
  endpoint: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let submittedPassword = false;
  // One action per screen: clicking a second time while the redirect is in
  // flight starts a fresh interaction and leaves the browser on the IdP.
  let actedOn = '';

  while (Date.now() < deadline) {
    if (isVerifierUrl(page.url(), endpoint)) {
      const loggedIn = await page.locator('#loggedIn').textContent({ timeout: 500 }).catch(() => '');
      if (loggedIn?.trim() === 'true') {
        return;
      }
    }

    const emailInput = page.locator('input[name="email"], input[type="email"], input#email').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"], input#password').first();
    if (await emailInput.isVisible({ timeout: 500 }).catch(() => false)
      && await passwordInput.isVisible({ timeout: 500 }).catch(() => false)) {
      // The form stays on screen while its POST is in flight; submitting it again
      // would start a second authorization and strand the browser on the IdP.
      const formKey = `${page.url()}|password:${account.email}`;
      if (formKey === actedOn) {
        await page.waitForTimeout(500);
        continue;
      }
      actedOn = formKey;
      await emailInput.fill(account.email);
      await passwordInput.fill(account.password);
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 5_000 }),
        passwordInput.press('Enter'),
      ]);
      submittedPassword = true;
      await page.waitForTimeout(1_000);
      // A single-page login submits through its own button, not the form's Enter
      // key, so the credential fields being still on screen means: press it.
      if (await passwordInput.isVisible({ timeout: 500 }).catch(() => false)) {
        const submit = page.getByRole('button', {
          name: /sign in|log in|login|submit|continue|登录|登陆|继续/i,
        }).first();
        if (await submit.isVisible({ timeout: 500 }).catch(() => false)) {
          await Promise.allSettled([
            page.waitForLoadState('domcontentloaded', { timeout: 5_000 }),
            submit.click(),
          ]);
        }
      }
      await page.waitForTimeout(500);
      continue;
    }

    // Consent verbs only: the verifier page's own "Login Xpod" button matches
    // `login`, and pressing it here would start a second authorization.
    const action = page.getByRole('button', {
      name: /authorize|allow|approve|consent|continue|yes|授权|允许|继续|批准|同意/i,
    }).first();
    if (await action.isVisible({ timeout: 500 }).catch(() => false)) {
      const actionKey = `${page.url()}|${(await action.textContent().catch(() => '')) ?? ''}`;
      if (actionKey !== actedOn) {
        actedOn = actionKey;
        await Promise.allSettled([
          page.waitForLoadState('domcontentloaded', { timeout: 5_000 }),
          action.click(),
        ]);
        await page.waitForTimeout(500);
      } else {
        await page.waitForTimeout(500);
      }
      continue;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`OIDC login did not finish before timeout; submittedPassword=${submittedPassword}; currentUrl=${page.url()}`);
}

function isVerifierUrl(currentUrl: string, endpoint: string): boolean {
  try {
    const current = new URL(currentUrl);
    const base = new URL(endpoint);
    return current.origin === base.origin && current.pathname === '/app/inrupt-smoke.html';
  } catch {
    return false;
  }
}

async function waitForLoggedIn(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const loggedIn = document.getElementById('loggedIn')?.textContent?.trim();
    return loggedIn === 'true';
  }, undefined, { timeout: timeoutMs });
}

async function clickAndWaitForReport(
  page: Page,
  buttonName: RegExp,
  predicate: (report: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  await page.getByRole('button', { name: buttonName }).click({ timeout: timeoutMs });
  const startedAt = Date.now();
  let lastReport: Record<string, any> | undefined;
  let lastText = '';

  while (Date.now() - startedAt < timeoutMs) {
    const text = await page.locator('#report').inputValue({ timeout: 1_000 }).catch(() => '');
    lastText = text;
    try {
      const report = JSON.parse(text) as Record<string, any>;
      lastReport = report;
      if (predicate(report)) {
        return report;
      }
      if (report.error) {
        throw new Error(String(report.error));
      }
    } catch (error) {
      if (error instanceof Error && lastReport?.error) {
        throw error;
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`report did not satisfy predicate for ${buttonName}; lastReport=${lastText.slice(0, 500)}`);
}

function resetStandaloneRuntimeRoot(): void {
  rmSync(LOCAL_ONLY_RUNTIME_ROOT, { recursive: true, force: true });
}

interface RuntimeProvisionStatus {
  origin?: string;
  managed?: boolean;
  oidcIssuer?: string;
  provisionCode?: string;
  status?: number;
  bodyPreview?: string;
  error?: string;
}

async function readRuntimeProvisionStatus(localGateway: string): Promise<RuntimeProvisionStatus> {
  const probeUrl = new URL('/provision/status', localGateway).toString();
  try {
    const response = await fetch(probeUrl, {
      headers: { accept: 'application/json' },
    });
    const body = await response.text();
    const parsed = JSON.parse(body) as {
      publicUrl?: unknown;
      managed?: unknown;
      oidcIssuer?: unknown;
      provisionCode?: unknown;
    };
    if (!response.ok || typeof parsed.publicUrl !== 'string') {
      return { status: response.status, bodyPreview: body.slice(0, 200) };
    }
    return {
      origin: new URL(parsed.publicUrl).origin,
      managed: parsed.managed === true,
      ...(typeof parsed.oidcIssuer === 'string' ? { oidcIssuer: parsed.oidcIssuer } : {}),
      ...(typeof parsed.provisionCode === 'string' ? { provisionCode: parsed.provisionCode } : {}),
      status: response.status,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The identity provider this runtime authenticates people with. A managed Local
 * runtime keeps its node registered with Cloud on purpose, and the account app
 * then authenticates against Cloud, so the smoke's account has to live there too.
 */
function managedIdentityIssuer(status: RuntimeProvisionStatus, localGateway: string): string | undefined {
  if (status.managed !== true || !status.oidcIssuer) {
    return undefined;
  }
  try {
    return new URL(status.oidcIssuer).origin === new URL(localGateway).origin
      ? undefined
      : new URL(status.oidcIssuer).origin;
  } catch {
    return undefined;
  }
}

interface ManagedAccountOptions {
  cloudIssuer: string;
  localGateway: string;
  provisionCode?: string;
}

/**
 * A Cloud account with a Local Pod, created the way the product creates them:
 * the account lives on the Cloud identity provider, the Pod directory is made by
 * this node's own provisioning API, and Cloud binds the two with the receipt.
 */
async function createManagedAccount(options: ManagedAccountOptions): Promise<PasswordAccount> {
  const suffix = Date.now().toString(36);
  const email = process.env.XPOD_SMOKE_CLOUD_EMAIL?.trim() || `inrupt-oidc-${suffix}@test.local`;
  const password = process.env.XPOD_SMOKE_CLOUD_PASSWORD?.trim() || `InruptOidc${suffix}!`;
  const podName = `inrupt-${suffix}`;

  const session = process.env.XPOD_SMOKE_CLOUD_EMAIL
    ? await loginCloudAccount(options.cloudIssuer, email, password)
    : await registerCloudAccount(options.cloudIssuer, email, password);

  const provisioned = await provisionLocalPod({
    localGateway: options.localGateway,
    provisionCode: options.provisionCode,
    podName,
  });
  const bound = await bindLocalPodAtCloud({
    cloudIssuer: options.cloudIssuer,
    accountToken: session.token,
    podControlUrl: session.podControlUrl,
    podName,
    provisionCode: options.provisionCode,
    provisionReceipt: provisioned.provisionReceipt,
  });

  const webId = bound.webId ?? provisioned.webId;
  if (!webId) {
    throw new Error('Local Pod provisioning returned no WebID to sign in with');
  }
  return { email, password, webId, podUrl: bound.podUrl ?? provisioned.podUrl, podName };
}

async function registerCloudAccount(
  cloudIssuer: string,
  email: string,
  password: string,
): Promise<{ token: string; podControlUrl: string }> {
  const createResponse = await fetch(new URL('/.account/account/', cloudIssuer).href, {
    method: 'POST',
    headers: ngrokJsonHeaders(),
    body: JSON.stringify({}),
  });
  const createBody = await createResponse.text().catch(() => '');
  if (!createResponse.ok) {
    throw new Error(`cloud account create failed: ${createResponse.status} ${createBody.slice(0, 200)}`);
  }
  const created = JSON.parse(createBody) as { authorization?: string };
  if (!created.authorization) {
    throw new Error(`cloud account create response missing authorization: ${createBody.slice(0, 200)}`);
  }
  // The create response advertises a reduced control set; the account index,
  // read with the new account's token, is what names the password endpoint.
  const controls = await readAccountControls(cloudIssuer, created.authorization);
  const passwordCreateUrl = controls.password?.create;
  if (!passwordCreateUrl) {
    throw new Error(`cloud account controls missing password.create: ${JSON.stringify(controls)}`);
  }
  const passwordResponse = await fetch(new URL(passwordCreateUrl, cloudIssuer).href, {
    method: 'POST',
    headers: {
      ...ngrokJsonHeaders(),
      Authorization: `CSS-Account-Token ${created.authorization}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const passwordBody = await passwordResponse.text().catch(() => '');
  if (!passwordResponse.ok) {
    throw new Error(`cloud password create failed: ${passwordResponse.status} ${passwordBody.slice(0, 200)}`);
  }
  return await loginCloudAccount(cloudIssuer, email, password);
}

async function readAccountControls(cloudIssuer: string, accountToken: string): Promise<AccountControls> {
  const response = await fetch(new URL('/.account/', cloudIssuer).href, {
    headers: {
      ...ngrokAcceptHeaders(),
      Authorization: `CSS-Account-Token ${accountToken}`,
    },
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`cloud account controls failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body) as { controls?: AccountControls };
  return parsed.controls ?? {};
}

async function loginCloudAccount(
  cloudIssuer: string,
  email: string,
  password: string,
): Promise<{ token: string; podControlUrl: string }> {
  const response = await fetch(new URL('/.account/login/password/', cloudIssuer).href, {
    method: 'POST',
    headers: ngrokJsonHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`cloud login failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const session = JSON.parse(body) as { authorization?: string };
  if (!session.authorization) {
    throw new Error(`cloud login response missing authorization: ${body.slice(0, 200)}`);
  }
  const controls = await readAccountControls(cloudIssuer, session.authorization);
  const podControlUrl = controls.account?.pod;
  if (!podControlUrl) {
    throw new Error(`cloud account controls missing account.pod: ${JSON.stringify(controls)}`);
  }
  return { token: session.authorization, podControlUrl: new URL(podControlUrl, cloudIssuer).href };
}

/**
 * The Pod directory for the account is created by this node, authorized by the
 * service token inside its own provision code - the same call the account app
 * makes, and the reason a Local Pod needs no inbound route from Cloud.
 */
async function provisionLocalPod(options: {
  localGateway: string;
  provisionCode: string | undefined;
  podName: string;
}): Promise<{ podUrl?: string; webId?: string; provisionReceipt: string }> {
  const scope = decodeProvisionScope(options.provisionCode);
  if (!scope) {
    throw new Error('this node published no usable provision code for Local Pod provisioning');
  }
  const response = await fetch(new URL('/provision/pods', options.localGateway).href, {
    method: 'POST',
    headers: {
      ...ngrokJsonHeaders(),
      Authorization: `Bearer ${scope.serviceToken}`,
    },
    body: JSON.stringify({ podName: options.podName }),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`local pod provisioning failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const provisioned = JSON.parse(body) as { podUrl?: unknown; webId?: unknown; provisionReceipt?: unknown };
  if (typeof provisioned.provisionReceipt !== 'string') {
    throw new Error(`local pod provisioning returned no receipt: ${body.slice(0, 200)}`);
  }
  return {
    provisionReceipt: provisioned.provisionReceipt,
    ...(typeof provisioned.podUrl === 'string' ? { podUrl: provisioned.podUrl } : {}),
    ...(typeof provisioned.webId === 'string' ? { webId: provisioned.webId } : {}),
  };
}

async function bindLocalPodAtCloud(options: {
  cloudIssuer: string;
  accountToken: string;
  podControlUrl: string;
  podName: string;
  provisionCode?: string;
  provisionReceipt: string;
}): Promise<{ webId?: string; podUrl?: string }> {
  const response = await fetch(new URL(options.podControlUrl, options.cloudIssuer).href, {
    method: 'POST',
    headers: {
      ...ngrokJsonHeaders(),
      Authorization: `CSS-Account-Token ${options.accountToken}`,
    },
    body: JSON.stringify({
      name: options.podName,
      settings: {
        ...(options.provisionCode ? { provisionCode: options.provisionCode } : {}),
        provisionReceipt: options.provisionReceipt,
      },
    }),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`cloud pod bind failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const bound = JSON.parse(body) as { webId?: unknown; pod?: unknown };
  return {
    ...(typeof bound.webId === 'string' ? { webId: bound.webId } : {}),
    ...(typeof bound.pod === 'string' ? { podUrl: bound.pod } : {}),
  };
}

interface AccountControls {
  password?: { create?: string; login?: string };
  account?: { pod?: string; clientCredentials?: string };
}

interface PodInterfaceKeyReport {
  before: string;
  registration: string;
  after: string;
  listed: number;
  internal: string;
}

/**
 * Prove the API reaches this Pod the way any client does: through the Pod's own Solid interface,
 * with the owner's own interface key.
 *
 * Registering the `sk-` wrapper is the grant, and the status read afterwards carries no caller
 * credential at all - only the sealed key can explain it succeeding.
 */
async function verifyPodInterfaceKey(input: {
  endpoint: string;
  identityBaseUrl: string;
  account: PasswordAccount;
}): Promise<PodInterfaceKeyReport> {
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(new URL(path, input.endpoint), {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });

  const session = await loginCloudAccount(input.identityBaseUrl, input.account.email, input.account.password);
  const controls = await readAccountControls(input.identityBaseUrl, session.token);
  const credentialsUrl = controls.account?.clientCredentials;
  if (!credentialsUrl) {
    throw new Error(`account controls expose no clientCredentials: ${JSON.stringify(controls)}`);
  }
  const issuedResponse = await fetch(new URL(credentialsUrl, input.identityBaseUrl).href, {
    method: 'POST',
    headers: { ...ngrokJsonHeaders(), Authorization: `CSS-Account-Token ${session.token}` },
    body: JSON.stringify({ name: `smoke-interface-key-${Date.now().toString(36)}`, webId: input.account.webId }),
  });
  const issuedBody = await issuedResponse.text().catch(() => '');
  if (!issuedResponse.ok) {
    throw new Error(`client credential issue failed: ${issuedResponse.status} ${issuedBody.slice(0, 200)}`);
  }
  const issued = JSON.parse(issuedBody) as { id?: string; secret?: string };
  if (!issued.id || !issued.secret) {
    throw new Error(`client credential issue returned no secret: ${issuedBody.slice(0, 200)}`);
  }
  const interfaceKey = `sk-${Buffer.from(`${issued.id}:${issued.secret}`, 'utf8').toString('base64')}`;

  const statusOf = async (): Promise<string> => {
    const response = await api('/api/pod/settings/status', {
      headers: { authorization: `Bearer ${interfaceKey}` },
    });
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      return `status ${response.status} ${body.slice(0, 120)}`;
    }
    const parsed = JSON.parse(body) as { aiConnection?: { status?: string; reason?: string } };
    return `${parsed.aiConnection?.status ?? 'missing'}/${parsed.aiConnection?.reason ?? 'no reason'}`;
  };

  const before = await statusOf();
  const registration = await api('/api/ai/gateway/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${interfaceKey}` },
    body: JSON.stringify({ apiKey: interfaceKey, name: 'smoke interface key', appliedTo: 'smoke' }),
  });
  const registrationBody = await registration.text().catch(() => '');
  if (!registration.ok) {
    throw new Error(`interface key registration failed: ${registration.status} ${registrationBody.slice(0, 200)}`);
  }
  const after = await statusOf();
  const listedResponse = await api('/api/ai/gateway/keys', {
    headers: { authorization: `Bearer ${interfaceKey}` },
  });
  const listedBody = await listedResponse.text().catch(() => '');
  const listed = listedResponse.ok
    ? ((JSON.parse(listedBody) as { data?: unknown[] }).data ?? []).length
    : 0;
  const internalResponse = await api('/.internal/pod-data');
  const internalBody = await internalResponse.text().catch(() => '');

  return {
    before,
    registration: `${registration.status}`,
    after,
    listed,
    internal: `${internalResponse.status} ${internalBody.slice(0, 40).replace(/\s+/gu, ' ')}`,
  };
}

/** The provision code carries the node's own provisioning credentials. */
function decodeProvisionScope(provisionCode: string | undefined): { serviceToken: string } | undefined {
  if (!provisionCode) return undefined;
  const encoded = provisionCode.split('.')[0];
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      serviceToken?: unknown;
      serviceAccessToken?: unknown;
      exp?: unknown;
    };
    const serviceToken = typeof payload.serviceAccessToken === 'string'
      ? payload.serviceAccessToken
      : typeof payload.serviceToken === 'string'
        ? payload.serviceToken
        : undefined;
    return serviceToken ? { serviceToken } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `set-cookie` header as a cookie for the origin the browser actually asked for.
 * Transport attributes are dropped on purpose: the request travels over the
 * access route, and the runtime decides what that route may carry.
 */
function accessRouteCookie(
  header: string,
  requestUrl: string,
): { name: string; value: string; domain: string; path: string; httpOnly?: boolean } | undefined {
  const [pair, ...attributes] = header.split(';');
  const separator = pair!.indexOf('=');
  if (separator <= 0) return undefined;
  const value = pair!.slice(separator + 1).trim();
  if (!value) return undefined;
  // The whole origin is one session: a path derived from the intercepted request
  // would keep the cookie away from the next hop (the OIDC interaction).
  return {
    name: pair!.slice(0, separator).trim(),
    value,
    domain: new URL(requestUrl).hostname,
    path: '/',
    ...(attributes.some((attribute) => /^\s*httponly/i.test(attribute)) ? { httpOnly: true } : {}),
  };
}

function byteLengthOf(body: BodyInit | null | undefined): number {
  return body && 'byteLength' in body && typeof body.byteLength === 'number' ? body.byteLength : 0;
}

function canonicalRouteTarget(canonicalOrigin: string, localGateway: string, requestUrl: string): string | undefined {
  try {
    const source = new URL(requestUrl);
    if (source.origin !== canonicalOrigin) {
      return undefined;
    }
    return new URL(`${source.pathname}${source.search}`, localGateway).href;
  } catch {
    return undefined;
  }
}

/**
 * Answer a canonical browser request from the loopback access route.
 *
 * The canonical host travels in the `x-xpod-canonical-*` headers so the runtime
 * keeps canonical semantics. A canonical redirect is rewritten to the same path on
 * the loopback origin instead of being followed here: the browser has to end up on
 * the route itself, because the pages it loads (the OIDC interaction app, for one)
 * route by path, and the login has to continue with the browser's own cookies.
 */
async function fulfillFromAccessRoute(
  route: Route,
  fetchImpl: typeof fetch,
  target: string,
  requestUrl: string,
  canonicalOrigin: string,
  headers: Record<string, string>,
  browserContext: BrowserContext,
  trace: Array<{ url: string; target?: string; status?: number; location?: string; error?: string }>,
  cookieTrace: Array<{ url: string; setCookie: string[]; jar: string[] }>,
): Promise<void> {
  const request = route.request();
  const body = request.postDataBuffer();
  const record: { url: string; target?: string; status?: number; location?: string; error?: string } = {
    url: requestUrl,
    target,
  };
  trace.push(record);

  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: request.method(),
      headers: {
        ...headers,
        'x-xpod-canonical-url': requestUrl,
        'x-xpod-canonical-origin': canonicalOrigin,
        'x-xpod-canonical-host': new URL(requestUrl).host,
      },
      redirect: 'manual',
      ...(body && byteLengthOf(body) > 0 ? { body } : {}),
    });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
  record.status = response.status;

  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    // The body is handed over decoded, so framing and encoding headers no longer
    // describe it, and `set-cookie` is re-joined below.
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(name)) {
      continue;
    }
    responseHeaders[name] = value;
  }
  // A fulfilled response cannot carry several `set-cookie` headers, so the
  // cookies go into the browser's own jar for the loopback origin instead: the
  // login continues on that origin with the session the runtime just issued.
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0 && browserContext) {
    const cookies = setCookies
      // The browser asked for the canonical origin, so that is the origin its own
      // cookie jar has to hold: the next request is sent by the browser, and this
      // handler only forwards what the browser sends.
      .map((header) => accessRouteCookie(header, requestUrl))
      .filter((cookie): cookie is NonNullable<typeof cookie> => Boolean(cookie));
    if (cookies.length > 0) {
      await browserContext.addCookies(cookies).catch(() => undefined);
    }
    cookieTrace.push({
      url: requestUrl,
      setCookie: setCookies.map((header) => header.split(';')[0]!),
      jar: (await browserContext.cookies().catch(() => [])).map((cookie) => `${cookie.name}@${cookie.domain}${cookie.path}`),
    });
  }

  const location = response.headers.get('location');
  if (location) {
    const next = new URL(location, requestUrl);
    record.location = next.href;
    if (next.origin === canonicalOrigin) {
      responseHeaders.location = new URL(`${next.pathname}${next.search}`, target).href;
    }
  }

  await route.fulfill({
    status: response.status,
    headers: responseHeaders,
    body: Buffer.from(await response.arrayBuffer()),
  }).catch((error: unknown) => {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  });
}

async function createPasswordAccount(fetchImpl: typeof fetch, baseUrl: string): Promise<PasswordAccount> {
  const suffix = Date.now().toString(36);
  const email = `inrupt-oidc-${suffix}@test.local`;
  const password = `InruptOidc${suffix}!`;
  const podName = `inrupt-${suffix}`;
  const headers = ngrokJsonHeaders();

  const accountResponse = await fetchImpl(new URL('/.account/account/', baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const accountBody = await accountResponse.text().catch(() => '');
  if (!accountResponse.ok) {
    throw new Error(`account create failed: ${accountResponse.status} ${accountBody.slice(0, 200)}`);
  }
  const accountData = JSON.parse(accountBody) as { authorization?: string };
  if (!accountData.authorization) {
    throw new Error(`account create response missing authorization: ${accountBody.slice(0, 200)}`);
  }

  const controlsResponse = await fetchImpl(new URL('/.account/', baseUrl), {
    headers: {
      ...ngrokAcceptHeaders(),
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
  });
  const controlsBody = await controlsResponse.text().catch(() => '');
  if (!controlsResponse.ok) {
    throw new Error(`account controls failed: ${controlsResponse.status} ${controlsBody.slice(0, 200)}`);
  }
  const controls = JSON.parse(controlsBody) as {
    controls?: {
      password?: { create?: string };
      account?: { pod?: string };
    };
  };

  const passwordCreateUrl = controls.controls?.password?.create;
  if (!passwordCreateUrl) {
    throw new Error(`account controls missing password.create: ${controlsBody.slice(0, 200)}`);
  }
  const passwordResponse = await fetchImpl(passwordCreateUrl, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
    body: JSON.stringify({ email, password }),
  });
  const passwordBody = await passwordResponse.text().catch(() => '');
  if (!passwordResponse.ok) {
    throw new Error(`password login create failed: ${passwordResponse.status} ${passwordBody.slice(0, 200)}`);
  }

  const podCreateUrl = controls.controls?.account?.pod;
  if (!podCreateUrl) {
    throw new Error(`account controls missing account.pod: ${controlsBody.slice(0, 200)}`);
  }
  const podResponse = await fetchImpl(podCreateUrl, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `CSS-Account-Token ${accountData.authorization}`,
    },
    body: JSON.stringify({ name: podName }),
  });
  const podBody = await podResponse.text().catch(() => '');
  if (!podResponse.ok) {
    throw new Error(`pod create failed: ${podResponse.status} ${podBody.slice(0, 200)}`);
  }
  const podData = JSON.parse(podBody) as { webId?: string; pod?: string };
  const webId = podData.webId;
  const podUrl = podData.pod ?? new URL(`/${podName}/`, baseUrl).toString();
  if (!webId) {
    throw new Error(`pod create response missing webId: ${podBody.slice(0, 200)}`);
  }

  return { email, password, webId, podUrl, podName };
}

function ngrokAcceptHeaders(): HeadersInit {
  return {
    Accept: 'application/json',
    'ngrok-skip-browser-warning': 'true',
  };
}

function ngrokJsonHeaders(): HeadersInit {
  return {
    ...ngrokAcceptHeaders(),
    'Content-Type': 'application/json',
  };
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

/** Headers a request keeps when the browser is allowed to reach the entry itself. */
function directRequestHeaders(route: Route): Record<string, string> {
  return { ...route.request().headers() };
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
    kind: 'ngrok-inrupt-oidc-smoke',
    dryRun: false,
    smokeOk: false,
    error: error instanceof Error ? error.message : String(error),
    proves: PROVES,
    caveats: CAVEATS,
  });
  process.exitCode = 1;
});
