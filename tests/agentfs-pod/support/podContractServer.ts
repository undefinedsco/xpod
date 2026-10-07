import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, readFileSync, statSync, openSync, readSync, closeSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface PodAccessLogEntry {
  method: string;
  path: string;
  resource: string | undefined;
  range: string | undefined;
  status: number;
  requestBytes: number;
  responseBytes: number;
  diskTransfer?: { bytesRead: number; chunks: number; maxReadGapMs: number; elapsedMs: number; sourceEnded: boolean; responseFinished: boolean; responseClosed: boolean };
}

interface StoredFile {
  content?: Buffer;
  /** Disk-backed body: the fixture never buffers a gigabyte in memory. */
  diskPath?: string;
  size: number;
  version: number;
  contentType: string;
}

export interface PodContractServerOptions {
  token?: string;
  deniedPaths?: string[];
  files?: Record<string, string | Buffer>;
  /**
   * Owned scratch PARENT for streamed PUT bodies. A unique private child is
   * created inside it and only that child is removed on close; the supplied
   * parent is never deleted. Defaults to an owned `.test-data` parent so the
   * fixture never leaks a generic tmpdir scratch.
   */
  scratchDir?: string;
}

export interface PodContractServer {
  origin: string;
  podRoot: string;
  log: PodAccessLogEntry[];
  /** Cumulative log that is never reset, for long-term evidence. */
  history: PodAccessLogEntry[];
  resetLog: () => void;
  readBody: (path: string) => string;
  /** Raw remote bytes for exact large-body hash comparison. */
  readBytes: (path: string) => Buffer;
  /** Bounded remote segment (never materialises a whole large body). */
  readSegment: (path: string, offset: number, length: number) => Buffer;
  fileSize: (path: string) => number;
  mutate: (path: string, content: string) => void;
  /** Seed a binary remote body (for large-file streaming/Range tests). */
  seedFile: (path: string, content: Buffer) => void;
  /** Seed a disk-backed large body; the fixture streams it instead of buffering. */
  seedDiskFile: (path: string, diskPath: string) => void;
  version: (path: string) => number;
  /** Apply the next successful mutation, then close before sending its receipt. */
  dropNextMutationReceipt: () => void;
  /** Hold the next body GET for `resource` open after `afterBytes` until releaseStall(). */
  stallOnce: (resource: string, afterBytes: number) => void;
  releaseStall: () => void;
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
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    store.set(key, {
      content: buffer,
      size: buffer.length,
      version: 1,
      contentType: 'text/plain',
    });
  }
  const log: PodAccessLogEntry[] = [];
  const history: PodAccessLogEntry[] = [];
  let dropNextMutationReceipt = false;
  // Controlled in-flight barrier: serve the first afterBytes of a body then
  // hold the connection open until releaseStall() so a real copy-up can be
  // interrupted while genuinely in flight.
  let stallTarget: { resource: string; afterBytes: number } | undefined;
  let stallRelease: (() => void) | undefined;
  // Disk scratch + bound: large PUTs stream to disk (never Buffer.concat a GiB).
  // Create a UNIQUE private child under an owned parent. On close remove ONLY
  // this created child, so a caller-supplied shared parent (and every external
  // seedDiskFile input) is never deleted.
  const scratchParent = options.scratchDir ?? path.resolve('.test-data');
  mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(scratchParent, 'xpod-pod-put-'));
  chmodSync(scratch, 0o700);
  const MAX_TEXT_BYTES = 8 * 1024 * 1024;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://placeholder');

      let status = 500;
      let responseBytes = 0;
      let requestBytes = 0;
      let resource: string | undefined;
      let diskTransfer: PodAccessLogEntry['diskTransfer'];
      const pipeDiskBody = (diskPath: string, start?: number, end?: number): void => {
        const progress = { bytesRead: 0, chunks: 0, maxReadGapMs: 0, elapsedMs: 0, sourceEnded: false, responseFinished: false, responseClosed: false };
        diskTransfer = progress;
        const started = performance.now(); let previous = started;
        const observe = (): void => { progress.elapsedMs = performance.now() - started; };
        const stream = createReadStream(diskPath, { start, end });
        stream.on('data', (chunk: Buffer | string) => {
          const now = performance.now();
          progress.bytesRead += Buffer.byteLength(chunk); progress.chunks++;
          progress.maxReadGapMs = Math.max(progress.maxReadGapMs, now - previous);
          previous = now; observe();
        });
        stream.on('end', () => { progress.sourceEnded = true; observe(); });
        stream.on('error', () => { observe(); response.destroy(); });
        response.on('finish', () => { progress.responseFinished = true; observe(); });
        response.on('close', () => { progress.responseClosed = true; observe(); stream.destroy(); });
        stream.pipe(response);
      };

      const streamBodyToDisk = async (): Promise<{ size: number; diskPath: string }> => {
        const diskPath = path.join(scratch, `put-${randomUUID()}.tmp`);
        const hash = createHash('sha256');
        let size = 0;
        // Persist a writer error from the moment the stream is opened so an
        // open/drain/request-iterator failure is never lost: whichever of the
        // two settles first (write finish or writer error) decides the outcome.
        const write = createWriteStream(diskPath, { flags: 'wx', mode: 0o600 });
        let writerError: Error | undefined;
        const errored = new Promise<never>((_resolve, reject) => {
          write.once('error', (error: Error) => { writerError = error; reject(error); });
        });
        let pump: Promise<void> | undefined;
        try {
          pump = (async (): Promise<void> => {
            for await (const chunk of request as AsyncIterable<Buffer>) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
              size += buf.length; hash.update(buf);
              if (!write.write(buf)) await once(write, 'drain');
            }
            write.end();
            await finished(write);
          })();
          await Promise.race([ pump, errored ]);
          if (writerError) throw writerError;
          void hash; // incremental hash during the stream; no whole-body buffer
          requestBytes = size;
          return { size, diskPath };
        } catch (error) {
          // Cancel THIS owned request so a blocked request-iterator cannot hang
          // the pump, then destroy the writer and await BOTH actual settlement
          // before removing only this call's partial.
          try { (request as unknown as { destroy?: () => void }).destroy?.(); } catch { /* closed */ }
          try { write.destroy(); } catch { /* already closed */ }
          await Promise.allSettled([ pump ?? Promise.resolve(), finished(write).catch(() => undefined) ]);
          try { rmSync(diskPath, { force: true }); } catch { /* absent */ } // remove only this call's partial
          throw error;
        }
      };

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
              .map(([ key, value ]) => ({ path: key, type: 'file', size: value.size, version: value.version }));
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
              if (value.content === undefined && value.size > MAX_TEXT_BYTES) continue; // bounded: never stringify a large disk body
              const lines = (value.content ?? readFileSync(value.diskPath as string)).toString('utf8').split('\n');
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
                const total = stored.size;
                const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
                const headers = (extra: Record<string, string | number> = {}) => ({
                  'content-type': stored.contentType, etag: etagFor(stored.version), 'accept-ranges': 'bytes', ...extra,
                });
                if (range?.startsWith('bytes=')) {
                  const spec = range.slice('bytes='.length).split(',')[0];
                  const [ startRaw, endRaw ] = spec.split('-');
                  const start = startRaw === '' ? total - Number.parseInt(endRaw, 10) : Number.parseInt(startRaw, 10);
                  const end = endRaw === '' || endRaw === undefined ? total - 1 : Number.parseInt(endRaw, 10);
                  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= total || start > end) {
                    send(416, Buffer.alloc(0), { 'content-range': `bytes */${total}` });
                  } else if (stored.diskPath) {
                    const length = end - start + 1;
                    status = 206; responseBytes = request.method === 'HEAD' ? 0 : length;
                    response.writeHead(206, headers({ 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': length }));
                    if (request.method === 'HEAD') { response.end(); } else {
                      pipeDiskBody(stored.diskPath, start, end);
                    }
                  } else {
                    const body = (stored.content as Buffer).subarray(start, end + 1);
                    // GET-only barrier: HEAD must NOT consume the stall target.
                    if (request.method === 'GET' && stallTarget && stallTarget.resource === resource && body.length > stallTarget.afterBytes) {
                      const after = stallTarget.afterBytes; stallTarget = undefined;
                      status = 206; responseBytes = body.length;
                      response.writeHead(206, headers({ 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': body.length }));
                      response.write(body.subarray(0, after));
                      stallRelease = () => { try { response.end(body.subarray(after)); } catch { /* client closed */ } };
                    } else {
                      send(206, body, headers({ 'content-range': `bytes ${start}-${end}/${total}` }));
                    }
                  }
                } else if (stored.diskPath) {
                  status = 200; responseBytes = request.method === 'HEAD' ? 0 : total;
                  response.writeHead(200, headers({ 'content-length': total }));
                  if (request.method === 'HEAD') { response.end(); } else {
                    pipeDiskBody(stored.diskPath);
                  }
                } else {
                  const body = stored.content as Buffer;
                  // GET-only barrier: HEAD must NOT consume the stall target.
                  if (request.method === 'GET' && stallTarget && stallTarget.resource === resource && body.length > stallTarget.afterBytes) {
                    const after = stallTarget.afterBytes; stallTarget = undefined;
                    status = 200; responseBytes = body.length;
                    response.writeHead(200, headers({ 'content-length': body.length }));
                    response.write(body.subarray(0, after));
                    stallRelease = () => { try { response.end(body.subarray(after)); } catch { /* client closed */ } };
                  } else {
                    send(200, body, headers());
                  }
                }
              }
            } else if (method === 'PUT') {
              const ifNoneMatch = request.headers['if-none-match'];
              const ifMatch = request.headers['if-match'];
              // Read the body BEFORE the version check (original ordering) so two
              // concurrent commits serialize on the re-read store version.
              const uploaded = await streamBodyToDisk();
              // A rejected upload is NEVER adopted by the store; retire only THIS
              // call's private scratch partial. The winner's store reference and
              // every external seedDiskFile input are left untouched.
              const retireUpload = (): void => { try { rmSync(uploaded.diskPath, { force: true }); } catch { /* absent */ } };
              const current = store.get(resource);
              if (ifNoneMatch === '*') {
                if (current) {
                  retireUpload();
                  send(412, JSON.stringify({ error: 'already exists' }));
                } else {
                  store.set(resource, { diskPath: uploaded.diskPath, size: uploaded.size, version: 1, contentType: 'application/octet-stream' });
                  send(201, JSON.stringify({ ok: true }), { etag: etagFor(1) });
                }
              } else if (typeof ifMatch === 'string') {
                if (!current || etagFor(current.version) !== ifMatch) {
                  retireUpload();
                  send(412, JSON.stringify({ error: 'version mismatch' }));
                } else {
                  const next = current.version + 1;
                  store.set(resource, { diskPath: uploaded.diskPath, size: uploaded.size, version: next, contentType: current.contentType });
                  send(204, Buffer.alloc(0), { etag: etagFor(next) });
                }
              } else {
                retireUpload();
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

      const entry: PodAccessLogEntry = {
        method: request.method ?? '',
        path: request.url ?? '',
        resource,
        range: typeof request.headers.range === 'string' ? request.headers.range : undefined,
        status,
        requestBytes,
        responseBytes,
        diskTransfer,
      };
      log.push(entry);
      history.push(entry);
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
    readBody: (target: string) => {
      const stored = store.get(target);
      if (!stored) return '';
      if (stored.content === undefined && stored.size > MAX_TEXT_BYTES) return ''; // bounded
      return (stored.content ?? readFileSync(stored.diskPath as string)).toString('utf8');
    },
    readBytes: (target: string) => {
      const stored = store.get(target);
      if (!stored) return Buffer.alloc(0);
      return stored.diskPath ? readFileSync(stored.diskPath) : Buffer.from(stored.content ?? Buffer.alloc(0));
    },
    readSegment: (target: string, offset: number, length: number) => {
      const stored = store.get(target);
      if (!stored) return Buffer.alloc(0);
      if (stored.diskPath) {
        const fd = openSync(stored.diskPath, 'r');
        try { const buffer = Buffer.alloc(length); const read = readSync(fd, buffer, 0, length, offset); return buffer.subarray(0, read); }
        finally { closeSync(fd); }
      }
      return (stored.content ?? Buffer.alloc(0)).subarray(offset, offset + length);
    },
    fileSize: (target: string) => store.get(target)?.size ?? 0,
    mutate: (target: string, content: string) => {
      const existing = store.get(target);
      const buffer = Buffer.from(content, 'utf8');
      store.set(target, {
        content: buffer,
        size: buffer.length,
        version: (existing?.version ?? 0) + 1,
        contentType: existing?.contentType ?? 'text/plain',
      });
    },
    seedFile: (target: string, content: Buffer) => {
      store.set(target, { content, size: content.length, version: 1, contentType: 'application/octet-stream' });
    },
    seedDiskFile: (target: string, diskPath: string) => {
      store.set(target, { diskPath, size: statSync(diskPath).size, version: 1, contentType: 'application/octet-stream' });
    },
    version: (target: string) => store.get(target)?.version ?? 0,
    dropNextMutationReceipt: () => { dropNextMutationReceipt = true; },
    stallOnce: (target: string, afterBytes: number) => { stallTarget = { resource: target, afterBytes }; },
    releaseStall: () => { const release = stallRelease; stallRelease = undefined; if (release) release(); },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      // Remove ONLY our owned scratch (PUT temp files); never external seedDiskFile inputs.
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* owned scratch absent */ }
    },
  };
}
