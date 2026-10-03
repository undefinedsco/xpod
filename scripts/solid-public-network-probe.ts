// Run inside the existing Xpod container, from /app, without loading .env files.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

type Stage = 'runtime' | 'input' | 'profile' | 'discovery' | 'jwks' | 'complete';
type Config = { webid: string; issuerOrigin: string };
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;
class ProbeError extends Error {
  constructor(readonly code: string) { super(code); }
}

function safeUrl(value: string, origins?: Set<string>): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProbeError('INVALID_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) {
    throw new ProbeError('UNSAFE_URL');
  }
  if (origins && !origins.has(url.origin)) { throw new ProbeError('ORIGIN_BLOCKED'); }
  return url;
}

function errorCode(error: unknown): string {
  if (error instanceof ProbeError) { return error.code; }
  const value = error as { code?: string; name?: string };
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ConnectionClosed', 'BunFetchSocketClosed', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
  if (value?.code && codes.has(value.code)) { return value.code; }
  const names: Record<string, string> = {
    TimeoutError: 'TIMEOUT', AbortError: 'ABORTED', SocketError: 'SOCKET_ERROR',
    SyntaxError: 'PARSE_ERROR', TypeError: 'FETCH_OR_TYPE_ERROR',
  };
  return names[value?.name ?? ''] ?? 'UNCLASSIFIED_ERROR';
}

export async function runProbe(config: Config, fetcher: typeof fetch = fetch,
  emit: (record: object) => void = (record) => console.log(JSON.stringify(record))): Promise<boolean> {
  let stage: Stage = 'runtime';
  let phase = 'setup';
  let status: number | undefined;
  let bytes = 0;
  let originHash: string | undefined;
  const record = (extra: object) => emit({ originHash, stage, phase, status, bytes, ...extra });
  try {
    record({ bun: Bun.version, node: process.versions.node });
    // /dev/stdin has no useful package resolution base; container cwd is /app.
    const { Parser } = createRequire(`${process.cwd()}/package.json`)('n3');
    if (typeof Parser !== 'function') { throw new ProbeError('PARSER_UNAVAILABLE'); }
    record({ result: 'parser-ready' });
    stage = 'input';
    if (!config || typeof config.webid !== 'string' || typeof config.issuerOrigin !== 'string') {
      throw new ProbeError('INVALID_INPUT');
    }
    const webid = new URL(config.webid);
    if (webid.hash !== '#me') { throw new ProbeError('INVALID_WEBID_FRAGMENT'); }
    webid.hash = '';
    const profile = safeUrl(webid.href);
    originHash = createHash('sha256').update(profile.origin).digest('hex');
    const issuer = safeUrl(config.issuerOrigin);
    if (issuer.pathname !== '/') { throw new ProbeError('INVALID_ISSUER_ORIGIN'); }
    const origins = new Set([profile.origin, issuer.origin]);

    const getText = async (url: URL, accept: string): Promise<string> => {
      safeUrl(url.href, origins);
      originHash = createHash('sha256').update(url.origin).digest('hex');
      phase = 'headers'; status = undefined; bytes = 0;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetcher(url.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit',
          headers: { Accept: accept }, signal: controller.signal,
        });
        status = response.status;
        record({ result: 'received' });
        if (status >= 300 && status < 400) { throw new ProbeError('REDIRECT_BLOCKED'); }
        if (!response.ok) { throw new ProbeError('HTTP_STATUS'); }
        phase = 'body';
        const length = response.headers.get('content-length');
        const expected = length && /^\d+$/.test(length) ? Number(length) : undefined;
        if (expected !== undefined && expected > MAX_BYTES) { throw new ProbeError('BODY_TOO_LARGE'); }
        if (!response.body) { throw new ProbeError('EMPTY_BODY'); }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) { break; }
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { throw new ProbeError('BODY_TOO_LARGE'); }
          chunks.push(value);
        }
        // Compressed length describes wire bytes, not the decoded stream.
        if (!response.headers.has('content-encoding') && expected !== undefined && bytes !== expected) {
          throw new ProbeError('BODY_TRUNCATED');
        }
        const body = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        record({ result: 'received' });
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) { void reader.cancel().catch(() => {}); }
      }
    };

    stage = 'profile';
    const turtle = await getText(profile, 'text/turtle');
    phase = 'parse';
    const quads = new Parser({ baseIRI: profile.href, format: 'text/turtle' }).parse(turtle);
    const issuers: string[] = [...new Set<string>(quads.filter((quad: any) =>
      quad.subject.termType === 'NamedNode' && quad.subject.value === config.webid &&
      quad.predicate.value === 'http://www.w3.org/ns/solid/terms#oidcIssuer' &&
      quad.object.termType === 'NamedNode').map((quad: any) => quad.object.value))];
    if (issuers.length !== 1) { throw new ProbeError('ISSUER_COUNT'); }
    const declaredIssuer = safeUrl(issuers[0], origins);
    if (declaredIssuer.href !== issuer.href) { throw new ProbeError('ISSUER_MISMATCH'); }
    record({ result: 'parsed' });

    stage = 'discovery';
    const discoveryText = await getText(new URL('.well-known/openid-configuration', issuer), 'application/json');
    phase = 'parse';
    const discovery = JSON.parse(discoveryText);
    if (discovery?.issuer !== issuer.href || typeof discovery?.jwks_uri !== 'string') {
      throw new ProbeError('INVALID_DISCOVERY');
    }
    const jwks = safeUrl(discovery.jwks_uri, new Set([issuer.origin]));
    record({ result: 'parsed' });

    stage = 'jwks';
    const keysText = await getText(jwks, 'application/json');
    phase = 'parse';
    const keys = JSON.parse(keysText);
    if (!Array.isArray(keys?.keys) || keys.keys.length === 0 ||
      keys.keys.some((key: any) => !key || typeof key.kty !== 'string')) {
      throw new ProbeError('INVALID_JWKS');
    }
    record({ result: 'parsed' });
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

if (import.meta.main) {
  let config: Config;
  try { config = JSON.parse(process.argv[2] ?? 'null'); } catch {
    console.log(JSON.stringify({ stage: 'input', phase: 'setup', result: 'failed', code: 'INVALID_INPUT' }));
    process.exit(1);
  }
  process.exitCode = await runProbe(config) ? 0 : 1;
}
