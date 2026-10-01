import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PodAccessLogEntry {
  method: string;
  path: string;
  resource: string | undefined;
  range: string | undefined;
  status: number;
  requestBytes: number;
  responseBytes: number;
}

interface StoredFile {
  content: Buffer;
  version: number;
  contentType: string;
}

export interface PodContractServerOptions {
  token?: string;
  deniedPaths?: string[];
  files?: Record<string, string | Buffer>;
}

export interface PodContractServer {
  origin: string;
  podRoot: string;
  log: PodAccessLogEntry[];
  /** Cumulative log that is never reset, for long-term evidence. */
  history: PodAccessLogEntry[];
  resetLog: () => void;
  readBody: (path: string) => string;
  mutate: (path: string, content: string) => void;
  version: (path: string) => number;
  /** Apply the next successful mutation, then close before sending its receipt. */
  dropNextMutationReceipt: () => void;
  close: () => Promise<void>;
}

const ROOT_PREFIX = '/pod/';
const LIST_PATH = '/-/agent-directory/list';
const SEARCH_PATH = '/-/agent-directory/search';

function readRequest(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function etagFor(version: number): string {
  return `"v${version}"`;
}

export async function startPodContractServer(options: PodContractServerOptions = {}): Promise<PodContractServer> {
  const token = options.token ?? 'test-token';
  const denied = new Set(options.deniedPaths ?? []);
  const store = new Map<string, StoredFile>();
  for (const [ key, value ] of Object.entries(options.files ?? {})) {
    store.set(key, {
      content: Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'),
      version: 1,
      contentType: 'text/plain',
    });
  }
  const log: PodAccessLogEntry[] = [];
  const history: PodAccessLogEntry[] = [];
  let dropNextMutationReceipt = false;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const requestBody = await readRequest(request);
      const url = new URL(request.url ?? '/', 'http://placeholder');

      let status = 500;
      let responseBytes = 0;
      let resource: string | undefined;

      const rawPathname = request.url ?? '/';
      const normalizedPathname = (() => {
        const questionMark = rawPathname.indexOf('?');
        const rawOnly = questionMark === -1 ? rawPathname : rawPathname.slice(0, questionMark);
        try {
          return decodeURIComponent(rawOnly);
        } catch {
          return rawOnly;
        }
      })();

      const send = (code: number, body: string | Buffer, headers: Record<string, string | number> = {}): void => {
        status = code;
        const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        responseBytes = request.method === 'HEAD' ? 0 : payload.length;
        if (dropNextMutationReceipt && (request.method === 'PUT' || request.method === 'DELETE') && code >= 200 && code < 300) {
          dropNextMutationReceipt = false;
          response.destroy();
          return;
        }
        response.writeHead(code, {
          'content-type': 'application/json',
          'content-length': payload.length,
          ...headers,
        });
        response.end(payload);
      };

      try {
        const authorized = (request.headers.authorization ?? '') === `Bearer ${token}`;
        const requestOrigin = `http://${request.headers.host ?? 'placeholder'}`;
        const rawRoot = url.searchParams.get('root');
        const rootOk = (() => {
          if (typeof rawRoot !== 'string' || rawRoot.length === 0) {
            return false;
          }
          try {
            const parsed = new URL(rawRoot);
            return parsed.origin === requestOrigin && parsed.search === '' && parsed.hash === '' && parsed.pathname.endsWith('/');
          } catch {
            return false;
          }
        })();
        const rawPrefix = url.searchParams.get('pathPrefix');
        let prefix = '';
        let prefixError = false;
        if (rawPrefix !== null && rawPrefix !== '') {
          const normalized = rawPrefix.replace(/^\/+/, '');
          if (normalized.length > 0) {
            const segments = normalized.split('/');
            if (segments[segments.length - 1] === '') {
              segments.pop();
            }
            if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.length === 0)) {
              prefixError = true;
            } else {
              prefix = `${segments.join('/')}/`;
            }
          }
        }

        if (normalizedPathname === LIST_PATH) {
          if (!authorized) {
            send(401, JSON.stringify({ error: 'unauthorized' }));
          } else if (!rootOk) {
            send(400, JSON.stringify({ error: 'list requires a same-origin canonical root' }));
          } else if (prefixError) {
            send(400, JSON.stringify({ error: 'Parameter "pathPrefix" must be a relative path without ".." or interior empty segments' }));
          } else {
            const entries = [ ...store.entries() ]
              .filter(([ key ]) => key.startsWith(prefix) && !denied.has(key))
              .map(([ key, value ]) => ({ path: key, type: 'file', size: value.content.length, version: value.version }));
            send(200, JSON.stringify({ entries, complete: true }));
          }
        } else if (normalizedPathname === SEARCH_PATH) {
          if (!authorized) {
            send(401, JSON.stringify({ error: 'unauthorized' }));
          } else if (!rootOk) {
            send(400, JSON.stringify({ error: 'search requires a same-origin canonical root' }));
          } else {
            const query = url.searchParams.get('q') ?? '';
            const matches: { path: string; line: number; column: number; text: string }[] = [];
            for (const [ key, value ] of store) {
              if (denied.has(key) || query.length === 0) {
                continue;
              }
              const lines = value.content.toString('utf8').split('\n');
              for (let index = 0; index < lines.length; index += 1) {
                const column = lines[index].indexOf(query);
                if (column >= 0) {
                  matches.push({ path: key, line: index + 1, column: column + 1, text: lines[index] });
                }
              }
            }
            send(200, JSON.stringify({ query, matches, complete: true, hasUnscannedScope: false }));
          }
        } else if (normalizedPathname === ROOT_PREFIX) {
          if (!authorized) {
            send(401, JSON.stringify({ error: 'unauthorized' }));
          } else {
            send(200, Buffer.alloc(0), { 'content-type': 'text/turtle', etag: '"dir"' });
          }
        } else if (normalizedPathname.startsWith(ROOT_PREFIX)) {
          resource = normalizedPathname.slice(ROOT_PREFIX.length);
          if (resource.length === 0 || resource.startsWith('/') || resource.split('/').includes('..')) {
            send(403, JSON.stringify({ error: 'path traversal' }));
          } else if (!authorized) {
            send(401, JSON.stringify({ error: 'unauthorized' }));
          } else if (denied.has(resource)) {
            send(403, JSON.stringify({ error: 'forbidden' }));
          } else {
            const stored = store.get(resource);
            const method = request.method ?? 'GET';
            if (method === 'HEAD' || method === 'GET') {
              if (!stored) {
                send(404, JSON.stringify({ error: 'not found' }));
              } else {
                const total = stored.content.length;
                const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
                if (range?.startsWith('bytes=')) {
                  const spec = range.slice('bytes='.length).split(',')[0];
                  const [ startRaw, endRaw ] = spec.split('-');
                  const start = startRaw === '' ? total - Number.parseInt(endRaw, 10) : Number.parseInt(startRaw, 10);
                  const end = endRaw === '' || endRaw === undefined ? total - 1 : Number.parseInt(endRaw, 10);
                  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= total || start > end) {
                    send(416, Buffer.alloc(0), { 'content-range': `bytes */${total}` });
                  } else {
                    const slice = stored.content.subarray(start, end + 1);
                    send(206, slice, {
                      'content-range': `bytes ${start}-${end}/${total}`,
                      'content-type': stored.contentType,
                      etag: etagFor(stored.version),
                      'accept-ranges': 'bytes',
                    });
                  }
                } else {
                  send(200, stored.content, {
                    'content-type': stored.contentType,
                    etag: etagFor(stored.version),
                    'accept-ranges': 'bytes',
                  });
                }
              }
            } else if (method === 'PUT') {
              const ifNoneMatch = request.headers['if-none-match'];
              const ifMatch = request.headers['if-match'];
              if (ifNoneMatch === '*') {
                if (stored) {
                  send(412, JSON.stringify({ error: 'already exists' }));
                } else {
                  store.set(resource, { content: requestBody, version: 1, contentType: 'application/octet-stream' });
                  send(201, JSON.stringify({ ok: true }), { etag: etagFor(1) });
                }
              } else if (typeof ifMatch === 'string') {
                if (!stored || etagFor(stored.version) !== ifMatch) {
                  send(412, JSON.stringify({ error: 'version mismatch' }));
                } else {
                  const next = stored.version + 1;
                  store.set(resource, { content: requestBody, version: next, contentType: stored.contentType });
                  send(204, Buffer.alloc(0), { etag: etagFor(next) });
                }
              } else {
                send(428, JSON.stringify({ error: 'if-match or if-none-match required' }));
              }
            } else if (method === 'DELETE') {
              const ifMatch = request.headers['if-match'];
              if (!stored) {
                send(404, JSON.stringify({ error: 'not found' }));
              } else if (typeof ifMatch !== 'string' || etagFor(stored.version) !== ifMatch) {
                send(412, JSON.stringify({ error: 'version mismatch' }));
              } else {
                store.delete(resource);
                send(204, Buffer.alloc(0));
              }
            } else {
              send(405, JSON.stringify({ error: 'method not allowed' }));
            }
          }
        } else {
          send(404, JSON.stringify({ error: 'not found in Pod contract' }));
        }
      } catch (error) {
        send(500, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }

      log.push({
        method: request.method ?? '',
        path: request.url ?? '',
        resource,
        range: typeof request.headers.range === 'string' ? request.headers.range : undefined,
        status,
        requestBytes: requestBody.length,
        responseBytes,
      });
      history.push(log[log.length - 1]);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    podRoot: `http://127.0.0.1:${address.port}${ROOT_PREFIX}`,
    log,
    history,
    resetLog: () => {
      log.length = 0;
    },
    readBody: (target: string) => store.get(target)?.content.toString('utf8') ?? '',
    mutate: (target: string, content: string) => {
      const existing = store.get(target);
      store.set(target, {
        content: Buffer.from(content, 'utf8'),
        version: (existing?.version ?? 0) + 1,
        contentType: existing?.contentType ?? 'text/plain',
      });
    },
    version: (target: string) => store.get(target)?.version ?? 0,
    dropNextMutationReceipt: () => { dropNextMutationReceipt = true; },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
