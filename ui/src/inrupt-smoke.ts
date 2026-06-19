import { Session } from '@inrupt/solid-client-authn-browser';

const session = new Session();

type SmokeResult = {
  url: string;
  status: number;
  ok: boolean;
  elapsedMs: number;
  headers: [string, string][];
  bodyPreview: string;
};

const params = new URLSearchParams(window.location.search);
const defaultCloudIssuer = params.get('issuer') || window.location.origin;
const defaultSpResourceUrl = params.get('sp') || new URL('/alice/a.txt', window.location.origin).href;

function render(): void {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020617; color: #e5e7eb; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; padding: 20px; background: radial-gradient(circle at top, rgba(59,130,246,.32), transparent 36%), #020617; }
      section, header { width: min(860px, 100%); margin: 0 auto 16px; padding: 18px; border: 1px solid rgba(148,163,184,.28); border-radius: 18px; background: rgba(15,23,42,.9); box-shadow: 0 18px 60px rgba(0,0,0,.28); }
      h1 { margin: 0 0 8px; font-size: clamp(26px, 6vw, 42px); }
      h2 { margin: 0 0 12px; font-size: 20px; }
      p { color: #cbd5e1; line-height: 1.62; }
      code { color: #93c5fd; }
      label { display: block; margin: 12px 0 7px; font-weight: 800; }
      input, textarea { width: 100%; min-height: 42px; padding: 10px 12px; border: 1px solid #475569; border-radius: 12px; background: #020617; color: #f8fafc; font: inherit; }
      textarea { min-height: 220px; font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; resize: vertical; }
      button { min-height: 42px; margin: 7px 7px 7px 0; padding: 10px 14px; border: 0; border-radius: 999px; background: #38bdf8; color: #082f49; font-weight: 900; cursor: pointer; }
      button.secondary { background: #334155; color: #e2e8f0; }
      dl { display: grid; grid-template-columns: minmax(110px, auto) 1fr; gap: 8px 12px; padding: 12px; border-radius: 14px; background: rgba(2,6,23,.62); }
      dt { color: #94a3b8; } dd { margin: 0; overflow-wrap: anywhere; }
      .ok { color: #86efac; } .fail { color: #fca5a5; } .warn { color: #fde68a; } .small { font-size: 13px; color: #94a3b8; }
    </style>
    <header>
      <h1>Inrupt Solid Smoke</h1>
      <p>这个页面使用 <code>@inrupt/solid-client-authn-browser</code> 登录 Cloud OIDC issuer，然后用 <code>session.fetch</code> 访问 SP 上的 Pod resource。</p>
      <p class="small">验收目标：标准 Inrupt browser SDK 能登录 Cloud，并跨到 SP 读 Solid/CSS 资源。Harmony/iOS App 只是 WebView 壳，不重写协议。</p>
    </header>
    <section>
      <h2>配置</h2>
      <label for="cloudIssuer">Cloud OIDC Issuer</label>
      <input id="cloudIssuer" inputmode="url" autocomplete="url" value="${escapeHtml(defaultCloudIssuer)}">
      <label for="spResourceUrl">SP Resource URL</label>
      <input id="spResourceUrl" inputmode="url" autocomplete="url" value="${escapeHtml(defaultSpResourceUrl)}">
      <button id="loginButton" type="button">1. Login Cloud</button>
      <button id="discoveryButton" type="button">2. Check Cloud Discovery</button>
      <button id="resourceButton" type="button">3. session.fetch SP Resource</button>
      <button id="logoutButton" class="secondary" type="button">Logout App</button>
      <dl>
        <dt>Status</dt><dd id="status">初始化中</dd>
        <dt>Logged in</dt><dd id="loggedIn">false</dd>
        <dt>WebID</dt><dd id="webId">-</dd>
      </dl>
    </section>
    <section>
      <h2>Report</h2>
      <textarea id="report" readonly></textarea>
    </section>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setStatus(message: string, kind = ''): void {
  const status = element<HTMLElement>('status');
  status.textContent = message;
  status.className = kind;
}

function cloudIssuer(): string {
  return element<HTMLInputElement>('cloudIssuer').value.trim();
}

function spResourceUrl(): string {
  return element<HTMLInputElement>('spResourceUrl').value.trim();
}

function normalizeBaseUrl(value: string): string {
  return new URL(value || window.location.origin, `${window.location.origin}/`).href;
}

function updateSessionInfo(): void {
  element<HTMLElement>('loggedIn').textContent = String(session.info.isLoggedIn);
  element<HTMLElement>('webId').textContent = session.info.webId ?? '-';
}

function writeReport(extra: Record<string, unknown> = {}): void {
  element<HTMLTextAreaElement>('report').value = JSON.stringify({
    generatedAt: new Date().toISOString(),
    cloudIssuer: cloudIssuer(),
    spResourceUrl: spResourceUrl(),
    session: {
      isLoggedIn: session.info.isLoggedIn,
      webId: session.info.webId,
      sessionId: session.info.sessionId,
    },
    ...extra,
  }, null, 2);
}

async function login(): Promise<void> {
  const issuer = normalizeBaseUrl(cloudIssuer());
  const redirectUrl = new URL('/app/inrupt-smoke.html', window.location.origin);
  redirectUrl.searchParams.set('issuer', issuer);
  redirectUrl.searchParams.set('sp', spResourceUrl());
  await session.login({
    oidcIssuer: issuer,
    redirectUrl: redirectUrl.href,
    clientName: 'Xpod Inrupt Smoke',
    tokenType: 'DPoP',
  });
}

async function fetchWithSession(url: string): Promise<SmokeResult> {
  const startedAt = performance.now();
  const response = await session.fetch(url, { method: 'GET', cache: 'no-store' });
  const text = await response.text();
  return {
    url,
    status: response.status,
    ok: response.ok,
    elapsedMs: Math.round(performance.now() - startedAt),
    headers: Array.from(response.headers.entries()),
    bodyPreview: text.slice(0, 8192),
  };
}

async function checkDiscovery(): Promise<void> {
  try {
    setStatus('checking cloud discovery...', 'warn');
    const discoveryUrl = new URL('/.well-known/openid-configuration', normalizeBaseUrl(cloudIssuer())).href;
    const result = await fetchWithSession(discoveryUrl);
    setStatus(`discovery HTTP ${result.status}`, result.ok ? 'ok' : 'fail');
    writeReport({ discovery: result });
  } catch (error) {
    fail(error);
  }
}

async function checkResource(): Promise<void> {
  try {
    setStatus('fetching SP resource with Inrupt session...', 'warn');
    const result = await fetchWithSession(new URL(spResourceUrl()).href);
    setStatus(`SP resource HTTP ${result.status}`, result.ok ? 'ok' : 'fail');
    writeReport({ spResource: result });
  } catch (error) {
    fail(error);
  }
}

async function logout(): Promise<void> {
  await session.logout({ logoutType: 'app' });
  updateSessionInfo();
  setStatus('logged out', 'warn');
  writeReport();
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message, 'fail');
  writeReport({ error: message });
}

async function boot(): Promise<void> {
  render();
  element<HTMLButtonElement>('loginButton').addEventListener('click', () => { void login(); });
  element<HTMLButtonElement>('discoveryButton').addEventListener('click', () => { void checkDiscovery(); });
  element<HTMLButtonElement>('resourceButton').addEventListener('click', () => { void checkResource(); });
  element<HTMLButtonElement>('logoutButton').addEventListener('click', () => { void logout(); });

  try {
    await session.handleIncomingRedirect({ restorePreviousSession: true });
    updateSessionInfo();
    setStatus(session.info.isLoggedIn ? 'logged in' : 'not logged in', session.info.isLoggedIn ? 'ok' : 'warn');
    writeReport();
  } catch (error) {
    fail(error);
  }
}

void boot();
