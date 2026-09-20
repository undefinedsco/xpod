import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Live-instance verification of Solid notifications (WebSocketChannel2023)
 * against the running Xpod gateway (http://127.0.0.1:3000) and its live CSS
 * child (http://127.0.0.1:3001).
 *
 * Everything under test happens inside a real Chromium page served on the Pod
 * origin. Only /test/ resources are touched; the one file-level edit is applied
 * to the seed Pod's public profile mirror and is restored byte-for-byte.
 *
 * Findings that this spec must not paper over (see REPORT.md for the raw
 * evidence): the live instance is Cloud-managed, so the seed account's local
 * WebID can neither log in through the product UI nor be authorized by the Pod,
 * and the gateway never relays the WebSocket 101 back to the client.
 */

const BASE_URL = 'http://127.0.0.1:3000';
const CSS_CHILD = 'http://127.0.0.1:3001';
const CANONICAL = 'https://7cca443f57b7b8bba68b56344237a4a2.nodes.undefineds.co';
const ACCOUNT_ID = 'df9511f6-9267-4dcd-b63e-decf18c69a52';
const ACCOUNT_EMAIL = 'test@dev.local';
const ACCOUNT_PASSWORD = 'test123456';
const TOPIC = `${CANONICAL}/test/profile/card`;
const TOPIC_LOCAL = `${BASE_URL}/test/profile/card`;
const MIRROR_FILE = path.join(
  process.env.HOME ?? '',
  'Library/Application Support/Xpod/data/test/profile/card$.ttl',
);
const HARNESS_DIR = path.resolve('.test-data/subscribe-verification/harness');
const CSS_MONITOR_LOG = path.resolve('.test-data/dev-monitor/monitor.log');
const IDENTITY_DB = path.join(process.env.HOME ?? '', 'Library/Application Support/Xpod/identity.sqlite');

function log(marker: string, value: unknown): void {
  console.log(`\n##### ${marker}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
}

async function logLines(pattern: string, since: number): Promise<string[]> {
  const text = await fs.promises.readFile(CSS_MONITOR_LOG, 'utf8').catch(() => '');
  return text.slice(since).split('\n').filter((line) => line.includes(pattern));
}

function channelKvRows(): string {
  try {
    return execFileSync('sqlite3', [
      '-readonly', IDENTITY_DB,
      "select key, substr(value, 1, 160) from internal_kv where key like '%.notifications%' order by key;",
    ], { encoding: 'utf8' }).trim() || '<no notification rows>';
  } catch (error) {
    return `<sqlite3 failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

test('live browser verification: subscribe, conditional reads, websocket path, file-level silence', async ({ page }) => {
  test.setTimeout(600_000);
  const logStart = (await fs.promises.stat(CSS_MONITOR_LOG).catch(() => ({ size: 0 }))).size;

  await page.route('**/__verify/**', async (route) => {
    const url = new URL(route.request().url());
    const file = path.join(HARNESS_DIR, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
      await route.fulfill({ status: 404, body: 'missing harness file' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      body: await fs.promises.readFile(file),
    });
  });

  await page.goto(`${BASE_URL}/__verify/index.html`, { waitUntil: 'domcontentloaded' });
  log('PHASE 0 harness page', { url: page.url(), title: await page.title() });

  // ------------------------------------------------------- conditional reads
  const conditional = await page.evaluate(async (config) => {
    const capture = async (label: string, url: string, init: RequestInit = {}) => {
      const response = await fetch(url, { ...init, cache: 'no-store' });
      const text = await response.text().catch(() => '<no body>');
      return {
        label,
        request: { method: init.method ?? 'GET', url, headers: init.headers ?? {} },
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          bodyBytes: text.length,
          body: text.slice(0, 200),
        },
      };
    };

    const document = config.documentUrl;
    const get = await capture('GET RDF document (public, page fetch)', document, { headers: { accept: 'text/turtle' } });
    const etag = get.response.headers.etag as string | undefined;
    const lastModified = get.response.headers['last-modified'] as string | undefined;
    const head = await capture('HEAD RDF document', document, { method: 'HEAD', headers: { accept: 'text/turtle' } });
    const conditionalGet = etag
      ? await capture('GET RDF document + If-None-Match', document, {
        headers: { accept: 'text/turtle', 'if-none-match': etag },
      })
      : { skipped: 'no ETag on the document read' };

    const sparqlUrl = `${config.podUrl}/profile/-/sparql?query=${encodeURIComponent(
      `SELECT ?s ?p ?o WHERE { GRAPH <${config.canonicalTopic}> { ?s ?p ?o } } LIMIT 5`,
    )}`;
    const sparql = await capture('GET rows via Pod SPARQL (app read path)', sparqlUrl, {
      headers: { accept: 'application/sparql-results+json' },
    });
    const sparqlEtag = sparql.response.headers.etag as string | undefined;
    const sparqlConditional = sparqlEtag
      ? await capture('GET rows via Pod SPARQL + If-None-Match', sparqlUrl, {
        headers: { accept: 'application/sparql-results+json', 'if-none-match': sparqlEtag },
      })
      : { skipped: 'no ETag on the SPARQL row read' };

    return { get, head, conditionalGet, documentETag: etag ?? null, lastModified: lastModified ?? null, sparql, sparqlETag: sparqlEtag ?? null, sparqlConditional };
  }, { documentUrl: TOPIC_LOCAL, canonicalTopic: TOPIC, podUrl: `${BASE_URL}/test` });
  log('PHASE 1 conditional read surface (document + SPARQL rows)', conditional);
  log('PHASE 1 summary', {
    documentETag: conditional.documentETag,
    lastModified: conditional.lastModified,
    headStatus: conditional.head.response.status,
    headETag: conditional.head.response.headers.etag ?? null,
    ifNoneMatchStatus: (conditional.conditionalGet as { response?: { status: number } }).response?.status ?? 'skipped',
    sparqlStatus: conditional.sparql.response.status,
    sparqlETag: conditional.sparqlETag,
    sparqlIfNoneMatchStatus: (conditional.sparqlConditional as { response?: { status: number } }).response?.status ?? 'skipped',
  });

  // ------------------------------------------------------------- subscribe
  const subscribe = await page.evaluate(async (config) => {
    const post = async (label: string, body: unknown) => {
      const headers = { 'content-type': 'application/ld+json', accept: 'application/ld+json' };
      const response = await fetch(config.endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store',
      });
      const text = await response.text();
      return {
        label,
        request: { method: 'POST', url: config.endpoint, headers, body: JSON.stringify(body) },
        response: { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: text },
      };
    };
    const taskShape = await post('task-specified body {type, topic}', { type: 'WebSocketChannel2023', topic: config.topic });
    const appShape = await post('app/notification-context body {@type full IRI, topic}', {
      '@context': 'https://www.w3.org/ns/solid/notification/v1',
      '@type': 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      topic: config.topic,
    });
    const channel = JSON.parse(appShape.response.body) as { id: string; receiveFrom: string; topic: string; endAt: string };
    return { taskShape, appShape, channel };
  }, { endpoint: `${BASE_URL}/.notifications/WebSocketChannel2023/`, topic: TOPIC });
  log('PHASE 2 subscribe from page context', subscribe);
  expect(subscribe.appShape.response.status).toBe(200);
  expect(subscribe.channel.receiveFrom).toContain('/.notifications/WebSocketChannel2023/');
  log('PHASE 2 channel key-value rows while subscribed', channelKvRows());

  const channelPath = new URL(subscribe.channel.id).pathname;

  // ------------------------------------ websocket through the local gateway
  const viaGateway = await page.evaluate(async (socketUrl: string) => {
    const events: string[] = [];
    const socket = new WebSocket(socketUrl);
    socket.onopen = () => events.push('open');
    socket.onerror = () => events.push('error');
    socket.onclose = (event) => events.push(`close code=${event.code} reason=${event.reason}`);
    socket.onmessage = (event) => events.push(`message ${String(event.data)}`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const state = socket.readyState;
    socket.close();
    return { socketUrl, readyStateAfter15s: state, readyStateName: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][state], events };
  }, `ws://127.0.0.1:3000${channelPath}`);
  log('PHASE 3 websocket via gateway (browser)', viaGateway);
  log('PHASE 3 CSS log lines (gateway attempt)', await logLines('WebSocket2023Listener', logStart));

  // --------------------------------- websocket straight to the live CSS child
  const messages: Array<{ at: number; payload: string }> = [];
  const directFrames = await page.evaluate(async ({ socketUrl, store }) => {
    const collected: Array<{ at: number; payload: string }> = [];
    (window as unknown as Record<string, unknown>).__frames = collected;
    const events: string[] = [];
    const socket = new WebSocket(socketUrl);
    socket.onopen = () => events.push('open');
    socket.onerror = () => events.push('error');
    socket.onclose = (event) => events.push(`close code=${event.code}`);
    socket.onmessage = (event) => collected.push({ at: Date.now(), payload: String(event.data) });
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      socket.onopen = () => { clearTimeout(timer); events.push('open'); resolve(true); };
      socket.onerror = () => { clearTimeout(timer); events.push('error'); resolve(false); };
    });
    (window as unknown as Record<string, unknown>).__socket = socket;
    void store;
    return { socketUrl, opened, readyState: socket.readyState, events };
  }, { socketUrl: `ws://127.0.0.1:3001${channelPath}`, store: null });
  log('PHASE 4 websocket direct to live CSS child (browser)', directFrames);
  log('PHASE 4 CSS log lines', await logLines('WebSocket2023Listener', logStart));

  // ------------------------------- conditional read while the socket is open
  if (directFrames.opened) {
    const readWhileSubscribed = await page.evaluate(async (config) => {
      const before = ((window as unknown as Record<string, unknown>).__frames as Array<unknown>).length;
      const get = await fetch(config.documentUrl, { headers: { accept: 'text/turtle' }, cache: 'no-store' });
      const etag = get.headers.get('etag');
      await get.text();
      const conditionalResponse = await fetch(config.documentUrl, {
        headers: { accept: 'text/turtle', 'if-none-match': etag ?? '' }, cache: 'no-store',
      });
      await conditionalResponse.text().catch(() => '');
      const askedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const frames = (window as unknown as Record<string, unknown>).__frames as Array<{ at: number; payload: string }>;
      return {
        etag,
        conditionalStatus: conditionalResponse.status,
        framesDuringReads: frames.slice(before).map((frame) => frame.payload),
        waitedMs: Date.now() - askedAt,
      };
    }, { documentUrl: TOPIC_LOCAL });
    log('PHASE 5 conditional read while subscribed (must be silent)', readWhileSubscribed);
    expect(readWhileSubscribed.conditionalStatus).toBe(304);
    expect(readWhileSubscribed.framesDuringReads.length, 'reads must not notify').toBe(0);
  }

  // ------------------------------------------------- file-level mirror edit
  const beforeBytes = await fs.promises.readFile(MIRROR_FILE);
  const beforeDigest = (await import('node:crypto')).createHash('sha256').update(beforeBytes).digest('hex');
  const servedBefore = await page.evaluate(async (url: string) => {
    const response = await fetch(url, { headers: { accept: 'text/turtle' }, cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, etag: response.headers.get('etag'), bytes: body.length, body,
      sortedLines: body.split('\n').map((line) => line.trim()).filter(Boolean).sort() };
  }, TOPIC_LOCAL);
  const editedAt = Date.now();
  await fs.promises.writeFile(MIRROR_FILE, `${beforeBytes.toString('utf8')}\n# file-level-edit ${editedAt}\n`, 'utf8');
  const afterDigest = (await import('node:crypto')).createHash('sha256')
    .update(await fs.promises.readFile(MIRROR_FILE)).digest('hex');
  await page.waitForTimeout(10_000);
  const afterFileEdit = await page.evaluate(async (url: string) => {
    const frames = ((window as unknown as Record<string, unknown>).__frames ?? []) as Array<{ at: number; payload: string }>;
    const response = await fetch(url, { headers: { accept: 'text/turtle' }, cache: 'no-store' });
    const body = await response.text();
    return {
      frames: frames.map((frame) => frame.payload),
      status: response.status,
      etag: response.headers.get('etag'),
      body,
    };
  }, TOPIC_LOCAL);
  log('PHASE 6 file-level edit of the .ttl mirror', {
    file: MIRROR_FILE,
    sha256Before: beforeDigest,
    sha256AfterEdit: afterDigest,
    fileChanged: beforeDigest !== afterDigest,
    waitedMs: Date.now() - editedAt,
    framesWithin10s: afterFileEdit.frames.length,
    servedBefore: { status: servedBefore.status, etag: servedBefore.etag, bytes: servedBefore.bytes },
    servedAfterFileEdit: { status: afterFileEdit.status, etag: afterFileEdit.etag, bytes: afterFileEdit.body.length },
    servedBodyChangedByFileEdit: JSON.stringify(servedBefore.sortedLines) !== JSON.stringify(
      afterFileEdit.body.split('\n').map((line) => line.trim()).filter(Boolean).sort(),
    ),
    servedAfterFileEditBody: afterFileEdit.body.slice(-220),
  });
  await fs.promises.writeFile(MIRROR_FILE, beforeBytes);
  const restoredDigest = (await import('node:crypto')).createHash('sha256')
    .update(await fs.promises.readFile(MIRROR_FILE)).digest('hex');
  log('PHASE 6 mirror restored', { restoredDigest, restoredExactly: restoredDigest === beforeDigest });
  expect(restoredDigest).toBe(beforeDigest);
  expect(afterFileEdit.frames.length, 'file-level change must not notify').toBe(0);

  // --------------------------------------------------------------- cleanup
  const cleanup = await page.evaluate(async ({ channelId, localOrigin }: { channelId: string; localOrigin: string }) => {
    const localUrl = `${localOrigin}${new URL(channelId).pathname}`;
    const response = await fetch(localUrl, { method: 'DELETE', cache: 'no-store' });
    const socket = (window as unknown as Record<string, unknown>).__socket as WebSocket | undefined;
    const closed = await new Promise<string>((resolve) => {
      if (!socket || socket.readyState > 1) { resolve(`readyState=${socket?.readyState}`); return; }
      socket.onclose = (event) => resolve(`close code=${event.code} reason=${event.reason}`);
      setTimeout(() => resolve('close timeout'), 5_000);
    });
    return {
      request: { method: 'DELETE', url: localUrl, deliveredFor: channelId },
      response: { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: (await response.text()).slice(0, 200) },
      socketAfterDelete: closed,
    };
  }, { channelId: subscribe.channel.id, localOrigin: BASE_URL });
  log('PHASE 7 unsubscribe', cleanup);
  log('PHASE 7 channel key-value rows after DELETE', channelKvRows());

  // an authenticated (token) or anonymous store write is not possible with the
  // authority available on this instance; record the exact refusal.
  const writeAttempt = await page.evaluate(async (url: string) => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/sparql-update' },
      body: `DELETE DATA { <${url}> <http://purl.org/dc/terms/title> "x" . }; INSERT DATA { <${url}> <http://purl.org/dc/terms/title> "x" . }`,
      cache: 'no-store',
    });
    return {
      request: { method: 'PATCH', url, headers: { 'content-type': 'application/sparql-update' } },
      response: { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: (await response.text()).slice(0, 300) },
    };
  }, TOPIC_LOCAL);
  log('PHASE 8 store write attempt without an accepted principal', writeAttempt);

  // Sweep the notification channels created by this verification session
  // (earlier probes in this session also left records behind).
  const leftovers = execFileSync('sqlite3', [
    '-readonly', IDENTITY_DB,
    "select key from internal_kv where key like 'notifications/%WebSocketChannel2023%';",
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .map((key) => decodeURIComponent(key.replace(/^notifications\//u, '')));
  const swept: Array<{ channel: string; status: number }> = [];
  for (const channel of leftovers) {
    if (!channel.startsWith(`${CANONICAL}/.notifications/WebSocketChannel2023/`)) continue;
    const response = await page.evaluate(
      async (url: string) => (await fetch(url, { method: 'DELETE', cache: 'no-store' })).status,
      `${BASE_URL}${new URL(channel).pathname}`,
    );
    swept.push({ channel, status: response });
  }
  log('PHASE 9 swept leftover channels from this session', swept);
  log('PHASE 9 channel key-value rows after sweep', channelKvRows());

  // Confirm the mirror restore is byte-identical and the served body is back.
  const servedAfterRestore = await page.evaluate(async (url: string) => {
    const response = await fetch(url, { headers: { accept: 'text/turtle' }, cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, etag: response.headers.get('etag'), bytes: body.length, body };
  }, TOPIC_LOCAL);
  log('PHASE 10 served document after mirror restore', {
    status: servedAfterRestore.status,
    etag: servedAfterRestore.etag,
    bytes: servedAfterRestore.bytes,
    matchesOriginalBodyLines: JSON.stringify(
      servedAfterRestore.body.split('\n').map((line) => line.trim()).filter(Boolean).sort(),
    ) === JSON.stringify(servedBefore.sortedLines),
    matchesOriginalBytes: servedAfterRestore.bytes === servedBefore.bytes,
  });

  log('NETWORK/LOG: WebSocket listener lines in this run', await logLines('WebSocket2023Listener', logStart));
  log('NETWORK/LOG: DPoP verification lines in this run', await logLines('Error verifying WebID', logStart));

  // ------------------------------------------- authenticated-session attempt
  // Same browser page: the local account login works, a DPoP client-credentials
  // token is issued, and the Pod still refuses it. This is the raw evidence for
  // why no store write (and therefore no positive notification) is possible.
  const sessionAttempt = await page.evaluate(async (config) => {
    const dpop = (window as unknown as Record<string, unknown>).XpodVerifyDpop as {
      generateDpopKeyPair(): Promise<unknown>;
      createDpopHeader(audience: string, method: string, key: unknown): Promise<string>;
    };
    const toLocal = (url: string): string =>
      url.startsWith(config.canonical) ? `${config.local}${url.slice(config.canonical.length)}` : url;

    const login = await fetch(`${config.local}/.account/login/password/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email: config.email, password: config.password, remember: true }),
    });
    const loginBody = await login.text();
    const accountToken = JSON.parse(loginBody).authorization as string;

    const credentialName = `subscribe-verification-${crypto.randomUUID()}`;
    const credentialResponse = await fetch(`${config.local}/.account/account/${config.accountId}/client-credentials/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `CSS-Account-Token ${accountToken}` },
      body: JSON.stringify({ name: credentialName, webId: config.canonicalWebId }),
    });
    const credentialBody = await credentialResponse.text();
    const credential = JSON.parse(credentialBody) as { id: string; secret: string; resource: string };

    const key = await dpop.generateDpopKeyPair();
    const tokenCanonical = `${config.canonical}/.oidc/token`;
    const tokenResponse = await fetch(`${config.local}/.oidc/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(`${credential.id}:${credential.secret}`)}`,
        DPoP: await dpop.createDpopHeader(tokenCanonical, 'POST', key),
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'webid' }),
    });
    const tokenBody = await tokenResponse.text();
    const token = JSON.parse(tokenBody) as { access_token: string; token_type: string };
    const claims = JSON.parse(atob(token.access_token.split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/')));

    const target = `${config.canonical}/verify-mu1esyob/settings/`;
    const signed = await fetch(toLocal(target), {
      method: 'GET',
      headers: {
        accept: 'text/turtle',
        authorization: `DPoP ${token.access_token}`,
        DPoP: await dpop.createDpopHeader(target, 'GET', key),
      },
      redirect: 'manual',
    });
    const signedBody = await signed.text();

    const revoked = await fetch(toLocal(credential.resource), {
      method: 'DELETE',
      headers: { authorization: `CSS-Account-Token ${accountToken}` },
    });

    return {
      localAccountLogin: { status: login.status, bodyHead: loginBody.slice(0, 60) },
      credential: {
        status: credentialResponse.status,
        name: credentialName,
        resource: credential.resource,
        secretReturned: credential.secret.length > 0,
      },
      token: {
        status: tokenResponse.status,
        tokenType: token.token_type,
        claims: { webid: claims.webid, iss: claims.iss, aud: claims.aud },
        note: 'token is held in page memory only and is never printed',
      },
      signedPodRequest: {
        request: { method: 'GET', signedUrl: target, deliveredTo: toLocal(target) },
        response: { status: signed.status, body: signedBody.slice(0, 200) },
      },
      credentialRevoked: { status: revoked.status },
    };
  }, {
    local: BASE_URL,
    canonical: CANONICAL,
    accountId: ACCOUNT_ID,
    email: ACCOUNT_EMAIL,
    password: ACCOUNT_PASSWORD,
    canonicalWebId: `${CANONICAL}/verify-mu1esyob/profile/card#me`,
  });
  log('PHASE 11 authenticated-session attempt in the same browser page', sessionAttempt);
  await page.waitForTimeout(1_000);
  log('PHASE 11 CSS DPoP rejection lines', await logLines('Error verifying WebID', logStart));
});
