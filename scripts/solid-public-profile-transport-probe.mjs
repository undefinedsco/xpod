// Identical anonymous public-profile GET, executed by Bun and by Node's built-in fetch.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ConnectionClosed', 'BunFetchSocketClosed', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function errorCode(error) {
  if (error instanceof ProbeError) return error.code;
  for (const value of [error, error?.cause]) {
    if (codes.has(value?.code)) return value.code;
  }
  return ({ AbortError: 'ABORTED', TimeoutError: 'TIMEOUT', SocketError: 'SOCKET_ERROR',
    TypeError: 'FETCH_OR_TYPE_ERROR' })[error?.name] ?? 'UNCLASSIFIED_ERROR';
}

export async function runTransportProbe(config, fetcher = fetch, resolver = lookup,
  emit = (row) => console.log(JSON.stringify(row))) {
  const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';
  let stage = 'runtime', phase = 'setup', originHash, status, bytes = 0, reader;
  const record = (extra) => emit({ runtime, originHash, stage, phase, status, bytes, ...extra });
  try {
    record({ ...(runtime === 'bun' ? { bun: Bun.version } : {}), node: process.versions.node });
    stage = 'input';
    if (typeof config?.webid !== 'string') throw new ProbeError('INVALID_INPUT');
    let url;
    try { url = new URL(config.webid); } catch { throw new ProbeError('INVALID_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.port || url.hash !== '#me') {
      throw new ProbeError('UNSAFE_URL');
    }
    url.hash = '';
    originHash = createHash('sha256').update(url.origin).digest('hex');
    stage = 'profile'; phase = 'dns';
    let dnsTimer;
    let addresses;
    try {
      addresses = await Promise.race([
        resolver(url.hostname, { all: true }),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new ProbeError('TIMEOUT')), TIMEOUT_MS); }),
      ]);
    } finally { clearTimeout(dnsTimer); }
    const families = new Set(addresses.map((entry) => entry.family));
    if (!families.size || [...families].some((family) => family !== 4 && family !== 6)) {
      throw new ProbeError('DNS_NO_ADDRESS');
    }
    record({ result: 'resolved', code: families.size === 2 ? 'DNS_MIXED' : families.has(4) ? 'DNS_IPV4' : 'DNS_IPV6' });
    // Addresses and hostname never leave this function. Use the canonical HTTPS URL.
    phase = 'headers';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'text/turtle' }, signal: controller.signal });
      status = response.status;
      record({ result: 'received' });
      if (status >= 300 && status < 400) throw new ProbeError('REDIRECT_BLOCKED');
      if (!response.ok) throw new ProbeError('HTTP_STATUS');
      phase = 'body';
      const length = response.headers.get('content-length');
      const expected = length && /^\d+$/.test(length) ? Number(length) : undefined;
      if (expected !== undefined && expected > MAX_BYTES) throw new ProbeError('BODY_TOO_LARGE');
      if (!response.body) throw new ProbeError('EMPTY_BODY');
      reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) throw new ProbeError('BODY_TOO_LARGE');
      }
      if (!bytes) throw new ProbeError('EMPTY_BODY');
      if (!response.headers.has('content-encoding') && expected !== undefined && expected !== bytes) {
        throw new ProbeError('BODY_TRUNCATED');
      }
      record({ result: 'received' });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
    stage = 'complete'; phase = 'complete'; status = undefined; bytes = 0;
    record({ result: 'passed' });
    return true;
  } catch (error) {
    record({ result: 'failed', code: errorCode(error) });
    stage = 'complete'; phase = 'complete'; status = undefined; bytes = 0;
    record({ result: 'failed' });
    return false;
  }
}

if (process.argv.includes('--profile-transport-probe')) {
  let config;
  try { config = JSON.parse(process.argv.at(-1) ?? 'null'); } catch {
    console.log(JSON.stringify({ stage: 'input', phase: 'setup', bytes: 0, result: 'failed', code: 'INVALID_INPUT' }));
    process.exit(1);
  }
  process.exitCode = await runTransportProbe(config) ? 0 : 1;
}
