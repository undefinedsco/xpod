import { Session } from '@inrupt/solid-client-authn-browser';

const session = new Session();

const SOLID_STORAGE = 'http://www.w3.org/ns/solid/terms#storage';
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#storage';
const DEFAULT_STORAGE_PATH = '.data/inrupt-smoke/probe.ttl#this';
const SMOKE_TYPE = 'https://schema.org/DigitalDocument';

type SmokeResult = {
  url: string;
  status: number;
  ok: boolean;
  elapsedMs: number;
  headers: [string, string][];
  bodyPreview: string;
};

type StorageDiscovery = {
  webId: string;
  profileUrl: string;
  storageUrl: string;
  profile: SmokeResult;
};

type StorageTarget = {
  storagePath: string;
  documentPath: string;
  tableBase: string;
  recordId: string;
};

const params = new URLSearchParams(window.location.search);
const defaultCloudIssuer = params.get('issuer') || window.location.origin;
const defaultPodHomeUrl = params.get('home') || '';
const defaultStoragePath = normalizeStoragePath(params.get('storagePath') || DEFAULT_STORAGE_PATH);
const defaultSpResourceUrl = params.get('sp') || '';

function render(): void {
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #020617; color: #e5e7eb; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; padding: 20px; background: radial-gradient(circle at top, rgba(59,130,246,.32), transparent 36%), #020617; }
      section, header { width: min(900px, 100%); margin: 0 auto 16px; padding: 18px; border: 1px solid rgba(148,163,184,.28); border-radius: 18px; background: rgba(15,23,42,.9); box-shadow: 0 18px 60px rgba(0,0,0,.28); }
      h1 { margin: 0 0 8px; font-size: clamp(26px, 6vw, 42px); }
      h2 { margin: 0 0 12px; font-size: 20px; }
      p { color: #cbd5e1; line-height: 1.62; }
      code { color: #93c5fd; }
      label { display: block; margin: 12px 0 7px; font-weight: 800; }
      input, textarea { width: 100%; min-height: 42px; padding: 10px 12px; border: 1px solid #475569; border-radius: 12px; background: #020617; color: #f8fafc; font: inherit; }
      textarea { min-height: 260px; font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; resize: vertical; }
      button { min-height: 42px; margin: 7px 7px 7px 0; padding: 10px 14px; border: 0; border-radius: 999px; background: #38bdf8; color: #082f49; font-weight: 900; cursor: pointer; }
      button.secondary { background: #334155; color: #e2e8f0; }
      button.danger { background: #fb7185; color: #450a0a; }
      dl { display: grid; grid-template-columns: minmax(120px, auto) 1fr; gap: 8px 12px; padding: 12px; border-radius: 14px; background: rgba(2,6,23,.62); }
      dt { color: #94a3b8; } dd { margin: 0; overflow-wrap: anywhere; }
      .ok { color: #86efac; } .fail { color: #fca5a5; } .warn { color: #fde68a; } .small { font-size: 13px; color: #94a3b8; }
    </style>
    <header>
      <h1>Inrupt Solid Smoke</h1>
      <p>这个页面从 Cloud IdP origin 加载，使用 <code>@inrupt/solid-client-authn-browser</code> 登录 Cloud OIDC issuer，然后读取 WebID profile 的 <code>solid:storage</code>，把发现到的 storage 设置为 Pod home。</p>
      <p class="small">读写验收使用 <code>@undefineds.co/drizzle-solid</code>：drizzle-solid db 的 <code>podUrl</code> 会设置成 storage home，再对 storage-relative RDF 资源执行 insert / findById / deleteById。</p>
    </header>
    <section>
      <h2>配置</h2>
      <label for="cloudIssuer">Cloud OIDC Issuer</label>
      <input id="cloudIssuer" inputmode="url" autocomplete="url" value="${escapeHtml(defaultCloudIssuer)}">
      <label for="podHomeUrl">Pod Home / Storage URL（自动从 WebID profile 的 solid:storage 填入，可手动覆盖）</label>
      <input id="podHomeUrl" inputmode="url" autocomplete="url" value="${escapeHtml(defaultPodHomeUrl)}" placeholder="https://node-0000.undefineds.co/alice/">
      <label for="storagePath">Storage-relative Drizzle Test Resource</label>
      <input id="storagePath" value="${escapeHtml(defaultStoragePath)}">
      <label for="spResourceUrl">SP Resource URL（可选；为空时按 Pod Home + Storage Path 推导）</label>
      <input id="spResourceUrl" inputmode="url" autocomplete="url" value="${escapeHtml(defaultSpResourceUrl)}">
      <button id="loginButton" type="button">1. Login Cloud</button>
      <button id="discoveryButton" type="button">2. Check Cloud Discovery</button>
      <button id="storageButton" type="button">3. Discover Storage Home</button>
      <button id="resourceButton" type="button">4. session.fetch SP Resource</button>
      <button id="drizzleButton" type="button">5. Drizzle Read/Write/Delete</button>
      <button id="logoutButton" class="secondary" type="button">Logout App</button>
      <dl>
        <dt>Status</dt><dd id="status">初始化中</dd>
        <dt>Logged in</dt><dd id="loggedIn">false</dd>
        <dt>WebID</dt><dd id="webId">-</dd>
        <dt>Storage Home</dt><dd id="storageHome">-</dd>
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

function podHomeUrl(): string {
  return element<HTMLInputElement>('podHomeUrl').value.trim();
}

function setPodHomeUrl(value: string): void {
  element<HTMLInputElement>('podHomeUrl').value = normalizeBaseUrl(value);
  element<HTMLElement>('storageHome').textContent = element<HTMLInputElement>('podHomeUrl').value;
}

function storagePath(): string {
  const normalized = normalizeStoragePath(element<HTMLInputElement>('storagePath').value);
  element<HTMLInputElement>('storagePath').value = normalized;
  return normalized;
}

function spResourceUrl(): string {
  return element<HTMLInputElement>('spResourceUrl').value.trim();
}

function setSpResourceUrl(value: string): void {
  element<HTMLInputElement>('spResourceUrl').value = value;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value || window.location.origin, `${window.location.origin}/`);
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return url.href;
}

function normalizeStoragePath(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return DEFAULT_STORAGE_PATH;
  }
  if (/^https?:\/\//iu.test(trimmed)) {
    const url = new URL(trimmed);
    return `${url.pathname.replace(/^\/+/, '')}${url.hash}` || DEFAULT_STORAGE_PATH;
  }
  return trimmed.replace(/^\/+/, '') || DEFAULT_STORAGE_PATH;
}

function splitStorageTarget(value: string): StorageTarget {
  const normalized = normalizeStoragePath(value);
  const hashIndex = normalized.indexOf('#');
  const documentPath = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
  const fragment = hashIndex >= 0 ? normalized.slice(hashIndex) : '';
  const slashIndex = documentPath.lastIndexOf('/');
  const directory = slashIndex >= 0 ? documentPath.slice(0, slashIndex + 1) : '';
  const fileName = slashIndex >= 0 ? documentPath.slice(slashIndex + 1) : documentPath;
  if (!fileName) {
    throw new Error(`Storage path must include a file name: ${normalized}`);
  }
  return {
    storagePath: normalized,
    documentPath,
    tableBase: `/${directory}`,
    recordId: `${fileName}${fragment || '#this'}`,
  };
}

function resourceUrlFromHome(homeUrl: string, pathValue: string): string {
  const target = splitStorageTarget(pathValue);
  return new URL(target.documentPath, normalizeBaseUrl(homeUrl)).href;
}

function updateSessionInfo(): void {
  element<HTMLElement>('loggedIn').textContent = String(session.info.isLoggedIn);
  element<HTMLElement>('webId').textContent = session.info.webId ?? '-';
  element<HTMLElement>('storageHome').textContent = podHomeUrl() || '-';
}

function writeReport(extra: Record<string, unknown> = {}): void {
  element<HTMLTextAreaElement>('report').value = JSON.stringify({
    generatedAt: new Date().toISOString(),
    cloudIssuer: cloudIssuer(),
    podHomeUrl: podHomeUrl(),
    storagePath: storagePath(),
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
  redirectUrl.searchParams.set('storagePath', storagePath());
  if (podHomeUrl()) {
    redirectUrl.searchParams.set('home', podHomeUrl());
  }
  if (spResourceUrl()) {
    redirectUrl.searchParams.set('sp', spResourceUrl());
  }
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

async function discoverStorage(): Promise<StorageDiscovery> {
  if (!session.info.isLoggedIn || !session.info.webId) {
    throw new Error('Login first; storage discovery needs session.info.webId.');
  }
  const webId = session.info.webId;
  const profileUrl = profileDocumentUrl(webId);
  const profile = await fetchWithSession(profileUrl);
  if (!profile.ok) {
    throw new Error(`Failed to read WebID profile ${profileUrl}: HTTP ${profile.status}`);
  }
  const storageUrl = normalizeBaseUrl(parseStorageFromProfile(webId, profile.bodyPreview));
  setPodHomeUrl(storageUrl);
  if (!spResourceUrl()) {
    setSpResourceUrl(resourceUrlFromHome(storageUrl, storagePath()));
  }
  updateSessionInfo();
  return { webId, profileUrl, storageUrl, profile };
}

async function checkStorage(): Promise<void> {
  try {
    setStatus('discovering storage home from WebID profile...', 'warn');
    const storage = await discoverStorage();
    setStatus(`storage home ${storage.storageUrl}`, 'ok');
    writeReport({ storage });
  } catch (error) {
    fail(error);
  }
}

async function ensurePodHome(): Promise<string> {
  if (podHomeUrl()) {
    const homeUrl = normalizeBaseUrl(podHomeUrl());
    setPodHomeUrl(homeUrl);
    return homeUrl;
  }
  return (await discoverStorage()).storageUrl;
}

async function resolveSpResourceUrl(): Promise<string> {
  if (spResourceUrl()) {
    return new URL(spResourceUrl()).href;
  }
  const homeUrl = await ensurePodHome();
  const url = resourceUrlFromHome(homeUrl, storagePath());
  setSpResourceUrl(url);
  return url;
}

async function checkResource(): Promise<void> {
  try {
    setStatus('fetching SP resource with Inrupt session...', 'warn');
    const result = await fetchWithSession(await resolveSpResourceUrl());
    setStatus(`SP resource HTTP ${result.status}`, result.ok ? 'ok' : 'fail');
    writeReport({ spResource: result });
  } catch (error) {
    fail(error);
  }
}

function parseStorageFromProfile(webId: string, profileText: string): string {
  const fromJson = parseStorageFromJson(profileText);
  if (fromJson) {
    return fromJson;
  }

  const iriPredicates = [SOLID_STORAGE, PIM_STORAGE]
    .map((predicate) => predicate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  const iriPattern = new RegExp(`<(?:${iriPredicates})>\\s+<([^>]+)>`, 'iu');
  const iriMatch = profileText.match(iriPattern);
  if (iriMatch?.[1]) {
    return iriMatch[1];
  }

  const prefixedPattern = /\b(?:solid|pim):storage\s+<([^>]+)>/iu;
  const prefixedMatch = profileText.match(prefixedPattern);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  const subjectPattern = new RegExp(`<${escapeRegExp(webId)}>[^.]+(?:<${escapeRegExp(SOLID_STORAGE)}>|solid:storage|<${escapeRegExp(PIM_STORAGE)}>|pim:storage)\\s+<([^>]+)>`, 'isu');
  const subjectMatch = profileText.match(subjectPattern);
  if (subjectMatch?.[1]) {
    return subjectMatch[1];
  }

  throw new Error(`WebID profile has no solid:storage / ${SOLID_STORAGE} binding.`);
}

function parseStorageFromJson(profileText: string): string | null {
  try {
    return findStorageInJson(JSON.parse(profileText));
  } catch {
    return null;
  }
}

function findStorageInJson(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStorageInJson(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of Object.keys(value)) {
    if (key === SOLID_STORAGE || key === PIM_STORAGE || key === 'solid:storage' || key === 'pim:storage') {
      const found = firstIriValue(value[key]);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = findStorageInJson(child);
    if (found) return found;
  }
  return null;
}

function firstIriValue(value: unknown): string | null {
  if (typeof value === 'string' && /^https?:\/\//iu.test(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstIriValue(item);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    const id = value['@id'];
    if (typeof id === 'string' && /^https?:\/\//iu.test(id)) {
      return id;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function profileDocumentUrl(webId: string): string {
  const url = new URL(webId);
  url.hash = '';
  return url.href;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function randomSuffix(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

async function checkDrizzleReadWrite(): Promise<void> {
  try {
    setStatus('writing smoke data through drizzle-solid...', 'warn');
    const homeUrl = await ensurePodHome();
    const target = splitStorageTarget(storagePath());
    const { drizzle, podTable, string } = await import('@undefineds.co/drizzle-solid');
    const smokeResource = podTable('inruptSmokeData', {
      id: string('id').primaryKey(),
      value: string('value').predicate('http://schema.org/text'),
      createdAt: string('createdAt').predicate('http://schema.org/dateCreated'),
    }, {
      base: target.tableBase,
      type: SMOKE_TYPE,
    });
    const db = drizzle(session as any, {
      podUrl: homeUrl,
      resourcePreparation: 'best-effort',
      schema: { inruptSmokeData: smokeResource },
    });
    await db.init(smokeResource);
    await db.deleteById(smokeResource, target.recordId).catch(() => undefined);

    const value = `xpod-inrupt-smoke ${new Date().toISOString()} ${randomSuffix()}`;
    const createdAt = new Date().toISOString();
    await db.insert(smokeResource).values({
      id: target.recordId,
      value,
      createdAt,
    });
    const readBack = await db.findById(smokeResource, target.recordId) as { value?: string; createdAt?: string } | null;
    const matches = readBack?.value === value;
    await db.deleteById(smokeResource, target.recordId).catch(() => undefined);

    if (!matches) {
      throw new Error(`drizzle-solid readback mismatch for ${target.recordId}`);
    }

    const resourceUrl = resourceUrlFromHome(homeUrl, target.storagePath);
    setSpResourceUrl(resourceUrl);
    setStatus('drizzle-solid write/read/delete OK', 'ok');
    writeReport({
      drizzleSolid: {
        ok: true,
        podUrl: homeUrl,
        storagePath: target.storagePath,
        tableBase: target.tableBase,
        recordId: target.recordId,
        resourceUrl,
        wrote: { value, createdAt },
        readBack,
        deleted: true,
      },
    });
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
  element<HTMLButtonElement>('storageButton').addEventListener('click', () => { void checkStorage(); });
  element<HTMLButtonElement>('resourceButton').addEventListener('click', () => { void checkResource(); });
  element<HTMLButtonElement>('drizzleButton').addEventListener('click', () => { void checkDrizzleReadWrite(); });
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
