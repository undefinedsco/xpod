// Root-owned actual HTTP/Engine boundary oracle; fixture identity is not DPoP/WAC/ACP acceptance.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, get, type Server, type ClientRequest, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PERMISSIONS } from '@solidlab/policy-engine';
import {
  AuthorizingHttpHandler, BasicRepresentation, BasicResponseWriter, ContentTypeMetadataWriter,
  IdentifierMap, MethodModesExtractor, OkResponseDescription, PermissionBasedAuthorizer,
  RepresentationMetadata, guardStream,
} from '@solid/community-server';
import type { ParsingHttpHandlerArgs, PermissionReaderInput } from '@solid/community-server';
import { DataFactory } from 'n3';
import { expect, it } from 'vitest';
import { LocalPhysicalParsingHttpHandler } from '../../src/http/LocalPhysicalParsingHttpHandler';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>(yes => { resolve = yes; }), resolve: () => resolve() };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([ promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Own HTTP fixture timed out: ${label}`)), 5000);
    }) ]);
  } finally { clearTimeout(timer); }
}

async function fixture(permission: () => Promise<void>, body: (engine: SolidRdfEngine, file: string) => Readable) {
  const parent = path.resolve('.test-data/authority-http-lifetime');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const file = path.join(directory, 'authority.txt');
  await writeFile(file, 'retained authority bytes');
  const operations = new LocalPhysicalOperationService(directory);
  const engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
  const graph = DataFactory.namedNode('https://root.invalid/alice/messages.ttl');
  const query = { patterns: [ { graph } ] };
  let server: Server | undefined;
  const clients: ClientRequest[] = [];
  const failures: unknown[] = [];
  const completions: Promise<void>[] = [];
  try {
    await engine.open();
    engine.replaceSource([ DataFactory.quad(DataFactory.namedNode(`${graph.value}#msg-id`),
      DataFactory.namedNode('urn:root:http-authority'), DataFactory.literal('allowed'), graph) ],
    { source: graph.value, workspace: 'https://root.invalid/alice/' });
    const authorized = new AuthorizingHttpHandler({
      credentialsExtractor: { handleSafe: async () => ({ agent: { webId: 'https://root.invalid/profile#me' } }) } as never,
      modesExtractor: new MethodModesExtractor({ hasResource: async () => true }),
      permissionReader: { handleSafe: async (input: PermissionReaderInput) => {
        expect(engine.query(query).bindings).toHaveLength(1);
        await permission();
        return new IdentifierMap([ ...input.requestedModes.entrySets() ].map(([ identifier ]) =>
          [ identifier, { [PERMISSIONS.Read]: true } ] as const));
      } } as never,
      authorizer: new PermissionBasedAuthorizer(),
      operationHandler: { handleSafe: async () => new OkResponseDescription(
        new RepresentationMetadata({ contentType: 'text/plain' }), guardStream(body(engine, file)),
      ) } as never,
    });
    const args: ParsingHttpHandlerArgs = {
      requestParser: { handleSafe: async (request: IncomingMessage) => ({
        method: request.method!, target: { path: `https://root.invalid${request.url}` }, body: new BasicRepresentation(),
      }) } as never,
      operationHandler: authorized,
      errorHandler: { handleSafe: async ({ error }: { error: unknown }) => { throw error; } } as never,
      responseWriter: new BasicResponseWriter(new ContentTypeMetadataWriter()),
    };
    const handler = new LocalPhysicalParsingHttpHandler(args, operations);
    server = createServer((request, response) => {
      const completed = handler.handleSafe({ request: guardStream(request), response }).catch(error => {
        failures.push(error);
        response.destroy(error instanceof Error ? error : undefined);
      });
      completions.push(completed);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Own HTTP fixture has no port'); }
    const request = (resource: string): Promise<IncomingMessage> => new Promise((resolve, reject) => {
      const client = get(`http://127.0.0.1:${address.port}${resource}`, resolve);
      clients.push(client);
      client.on('error', reject);
    });
    return { operations, engine, query, request, completions, failures, cleanup: async () => {
      for (const client of clients) { client.destroy(); }
      server!.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      await within(Promise.all(completions), 'handler cleanup');
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    server?.closeAllConnections();
    server?.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

it('holds the physical domain while actual CSS permission reading is paused before authorization', async () => {
  const entered = deferred();
  const authorize = deferred();
  const context = await fixture(async () => { entered.resolve(); await authorize.promise; },
    (_engine, file) => Readable.from([ readFileSync(file) ]));
  const response = context.request('/alice/messages.ttl');
  try {
    await within(entered.promise, 'permission reader');
    for (const runtime of [ 'bun', 'node' ] as const) {
      expect(authoritySqlitePeerAdmission(runtime, context.operations.databasePath)).toBe(false);
    }
    expect(() => context.engine.query(context.query)).toThrowError(expect.objectContaining({ statusCode: 503 }));
    authorize.resolve();
    const stream = await within(response, 'healthy response');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) { chunks.push(Buffer.from(chunk)); }
    expect(stream.statusCode).toBe(200);
    expect(Buffer.concat(chunks).toString()).toBe('retained authority bytes');
    await within(Promise.all(context.completions), 'healthy handler completion');
    expect(context.failures).toEqual([]);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally { authorize.resolve(); await response.catch(() => undefined); await context.cleanup(); }
}, 30_000);

it('keeps an aborted HTTP source protected until slow actual destroy cleanup confirms completion', async () => {
  const destroyStarted = deferred();
  const finishDestroy = deferred();
  let actualReads = 0;
  let producerClosed = false;
  let contextError: unknown;
  let sourceStream: Readable | undefined;
  let work: ReturnType<typeof setInterval> | undefined;
  const context = await fixture(async () => undefined, (engine, file) => {
    let emitted = false;
    sourceStream = new Readable({
      read() {
        if (emitted) { return; }
        emitted = true;
        try {
          expect(engine.query({ patterns: [] }).bindings).toBeDefined();
          this.push(readFileSync(file));
          actualReads += 1;
          work = setInterval(() => { readFileSync(file); actualReads += 1; }, 10);
        } catch (error) { contextError = error; this.destroy(error as Error); }
      },
      destroy(error, callback) {
        try { engine.query({ patterns: [] }); } catch (caught) { contextError = caught; }
        destroyStarted.resolve();
        void finishDestroy.promise.then(() => {
          clearInterval(work);
          producerClosed = true;
          callback(error);
        });
      },
    });
    return sourceStream;
  });
  let response: IncomingMessage | undefined;
  try {
    response = await within(context.request('/alice/messages.ttl.acl'), 'stream response');
    await within(new Promise<void>((resolve, reject) => {
      response!.once('data', () => resolve()); response!.once('error', reject);
    }), 'first source bytes');
    response.destroy();
    await within(destroyStarted.promise, 'source destroy request');
    expect(contextError, 'lazy read and destroy must run in the original active context').toBeUndefined();
    expect(sourceStream?.closed).toBe(false);
    expect(producerClosed).toBe(false);
    expect(actualReads).toBeGreaterThan(0);
    for (const runtime of [ 'bun', 'node' ] as const) {
      expect(authoritySqlitePeerAdmission(runtime, context.operations.databasePath)).toBe(false);
    }
    expect(() => context.engine.storageStats()).toThrowError(expect.objectContaining({ statusCode: 503 }));
    finishDestroy.resolve();
    await within(Promise.all(context.completions), 'confirmed source cleanup');
    expect(sourceStream?.closed).toBe(true);
    expect(producerClosed).toBe(true);
    expect(context.failures).toEqual([]);
    expect(authoritySqlitePeerAdmission('bun', context.operations.databasePath)).toBe(true);
  } finally {
    finishDestroy.resolve();
    response?.destroy();
    sourceStream?.destroy();
    clearInterval(work);
    await context.cleanup();
  }
}, 30_000);
