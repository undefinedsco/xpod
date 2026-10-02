import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { authFetch, requireAuthContext } from '../lib/auth-context';

export interface AuthProxyOptions {
  /** Real Pod container root, e.g. https://pod.example/alice/ */
  podRoot: string;
  /** Fixed capability for tests/helper IPC; a random 32-byte one is generated otherwise. */
  capability?: string;
  /** Called after an authenticated local shutdown response has been sent. */
  onShutdown?: () => void;
}

export interface AuthProxy {
  /** Pure loopback origin (no capability in the URL). */
  origin: string;
  /** Per-mount capability; callers must send it as `x-xpod-agentfs-capability`. */
  capability: string;
  podRoot: string;
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CAPABILITY_HEADER = 'x-xpod-agentfs-capability';
const MAX_REDIRECTS = 3;

function canonicalTarget(raw: string, realRoot: URL, transportOrigin: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // The target must be a URL on the real Pod origin that canonicalizes to the
  // bound Pod root (Alice). A loopback URL is rewritten if it points at the
  // same Pod path.
  if ((parsed.origin === realRoot.origin || parsed.origin === transportOrigin) && parsed.pathname.startsWith(realRoot.pathname)) {
    return `${realRoot.origin}${parsed.pathname}${parsed.search}`;
  }
  return undefined;
}

function rewriteSidecarTargets(search: string, realRoot: URL, transportOrigin: string): { search: string } | { error: string } {
  const params = new URLSearchParams(search);
  for (const key of [ 'root', 'url' ]) {
    const value = params.get(key);
    if (!value) {
      continue;
    }
    const canonical = canonicalTarget(value, realRoot, transportOrigin);
    if (!canonical) {
      return { error: `sidecar parameter "${key}" points outside the proxied Pod root` };
    }
    params.set(key, canonical);
  }
  return { search: `?${params.toString()}` };
}

/**
 * Device-side loopback proxy bound to a single Pod root and a single per-mount
 * capability.
 *
 * The origin is a pure loopback origin; the capability is a 32-byte random
 * secret delivered to the helper through its private environment/IPC. Requests
 * without the capability are refused before any Pod request. Forwarding always
 * goes through the CLI's authoritative `authFetch`; the helper never owns
 * credentials.
 */
export async function startAuthProxy(options: AuthProxyOptions): Promise<AuthProxy> {
  const realRoot = new URL(options.podRoot.endsWith('/') ? options.podRoot : `${options.podRoot}/`);
  const podPath = realRoot.pathname;
  const capability = options.capability ?? randomBytes(32).toString('hex');

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');

      // 1. Capability gate: header only, never the URL.
      const headerCap = request.headers[CAPABILITY_HEADER];
      if (typeof headerCap !== 'string' || headerCap !== capability) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing per-mount capability' }));
        return;
      }

      if (incoming.pathname === '/-/agentfs-proxy/shutdown' && options.onShutdown) {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        response.once('finish', options.onShutdown);
        response.writeHead(204);
        response.end();
        return;
      }

      // 2. Map path: resources live under the Pod path; the sidecar is at root.
      let forwardPath: string;
      let forwardSearch = incoming.search;
      if (incoming.pathname.startsWith(podPath)) {
        forwardPath = incoming.pathname;
      } else if (incoming.pathname.startsWith('/-/agent-directory/')) {
        forwardPath = incoming.pathname;
        const transport = server.address() as AddressInfo;
        const rewritten = rewriteSidecarTargets(incoming.search, realRoot, `http://127.0.0.1:${transport.port}`);
        if ('error' in rewritten) {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: rewritten.error }));
          return;
        }
        forwardSearch = rewritten.search;
      } else {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'path outside the proxied Pod root' }));
        return;
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        const lower = key.toLowerCase();
        if (lower === 'host' || lower === 'authorization' || lower === CAPABILITY_HEADER || HOP_BY_HOP.has(lower)) {
          continue;
        }
        if (typeof value === 'string') {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(', ');
        }
      }

      const safeMethod = request.method === 'GET' || request.method === 'HEAD';
      const hasBody = !safeMethod;
      // Bun can transparently retry a disconnected pooled request, including
      // streaming mutations. A lost receipt belongs to journal recovery, never
      // to the transport's retry path. Fresh, closing connections avoid it.
      if (hasBody) { headers.connection = 'close'; }
      const init: RequestInit = {
        method: request.method,
        headers,
        redirect: 'manual',
        ...(hasBody ? { keepalive: false } : {}),
        ...(hasBody ? { body: Readable.toWeb(request) as unknown as BodyInit, duplex: 'half' } as RequestInit : {}),
      };

      const fetchOnce = async (url: string, forceRefresh: boolean): Promise<Response> =>
        authFetch(await requireAuthContext({ forceRefresh }), url, init);

      try {
        let currentUrl = `${realRoot.origin}${forwardPath}${forwardSearch}`;
        let upstream = await fetchOnce(currentUrl, false);

        // A mutating body stream cannot be replayed; return the retryable 401
        // instead of silently reusing a consumed stream (which would 502).
        if (upstream.status === 401 && safeMethod) {
          upstream = await fetchOnce(currentUrl, true);
        }

        // Manual redirects: verify every hop stays inside this Pod before following.
        let hops = 0;
        while (upstream.status >= 300 && upstream.status < 400 && safeMethod && hops < MAX_REDIRECTS) {
          const location = upstream.headers.get('location');
          if (!location) {
            break;
          }
          const resolved = new URL(location, currentUrl);
          if (resolved.origin !== realRoot.origin || !resolved.pathname.startsWith(podPath)) {
            response.writeHead(403, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'redirect outside the Pod root' }));
            return;
          }
          currentUrl = resolved.href;
          upstream = await fetchOnce(currentUrl, false);
          hops += 1;
        }

        if (upstream.status >= 300 && upstream.status < 400) {
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unhandled Pod redirect' }));
          return;
        }

        const responseHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'content-length') {
            return;
          }
          responseHeaders[key] = value;
        });
        const upstreamLength = upstream.headers.get('content-length');
        if (upstreamLength) {
          responseHeaders['content-length'] = upstreamLength;
        }
        response.writeHead(upstream.status, responseHeaders);
        if (request.method === 'HEAD' || !upstream.body) {
          response.end();
          return;
        }
        await pipeline(Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream), response);
      } catch (error) {
        if (response.headersSent || response.destroyed) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    capability,
    podRoot: options.podRoot,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
