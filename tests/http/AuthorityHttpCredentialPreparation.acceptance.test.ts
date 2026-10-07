// Root-owned real HTTP/SQLite regression. Declared fixture credentials are not real DPoP verification.
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CachedHandler } from 'asynchronous-handlers';
import { PERMISSIONS } from '@solidlab/policy-engine';
import {
  AuthorizingHttpHandler, BadRequestHttpError, BasicRepresentation, BasicResponseWriter,
  ContentTypeMetadataWriter, IdentifierMap, MethodModesExtractor, OkResponseDescription,
  PermissionBasedAuthorizer, RepresentationMetadata, guardStream,
} from '@solid/community-server';
import type { CredentialsExtractor, ParsingHttpHandlerArgs, PermissionReaderInput } from '@solid/community-server';
import { DataFactory } from 'n3';
import { expect, it } from 'vitest';
import { LocalPhysicalParsingHttpHandler } from '../../src/http/LocalPhysicalParsingHttpHandler';
import { LocalPhysicalOperationService } from '../../src/storage/LocalPhysicalOperationService';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { authoritySqlitePeerAdmission } from '../helpers/AuthoritySqlitePeer';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([ promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned credential HTTP fixture exceeded 10s')), 10_000);
    }) ]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const parent = path.resolve('.test-data/authority-http-credentials');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const profileFile = path.join(directory, 'profile.ttl');
  await writeFile(profileFile, '<urn:fixture:me> <urn:fixture:issuer> <urn:fixture:trusted> .');
  const operations = new LocalPhysicalOperationService(directory);
  const engine = new SolidRdfEngine({ operationService: operations, index: { path: path.join(directory, 'facts.sqlite') } });
  let server: Server | undefined;
  let origin = '';
  const completions: Promise<void>[] = [];
  const failures: unknown[] = [];
  const extraction = new Map<string, number>();
  const permissionPaths: string[] = [];
  let profileRequests = 0;
  let errorsWritten = 0;
  try {
    await engine.open();
    const graph = DataFactory.namedNode('https://root.invalid/authority.ttl');
    engine.replaceSource([ DataFactory.quad(DataFactory.namedNode(`${graph.value}#record`),
      DataFactory.namedNode('urn:fixture:current'), DataFactory.literal('yes'), graph) ],
    { source: graph.value, workspace: 'https://root.invalid/' });
    const credentials = new CachedHandler({
      canHandle: async () => undefined,
      handle: async (request: IncomingMessage) => {
        const key = `${request.url}:${request.headers.authorization ?? 'anonymous'}`;
        extraction.set(key, (extraction.get(key) ?? 0) + 1);
        if (request.headers.authorization === 'Bearer refused-fixture') {
          throw new BadRequestHttpError('Fixture credential rejected');
        }
        if (request.headers.authorization) {
          // A real new anonymous HTTP request must acquire the same domain without inheriting ALS.
          const profile = await fetch(`${origin}/profile/card`, { signal: AbortSignal.timeout(4000) });
          if (profile.status !== 200 || await profile.text() !== await readFile(profileFile, 'utf8')) {
            throw new BadRequestHttpError('Fixture issuer profile unavailable');
          }
          return { agent: { webId: 'urn:fixture:me' } };
        }
        return {};
      },
    } as never) as unknown as CredentialsExtractor;
    const authorizing = new AuthorizingHttpHandler({
      credentialsExtractor: credentials,
      modesExtractor: new MethodModesExtractor({ hasResource: async () => true }),
      permissionReader: { handleSafe: async (input: PermissionReaderInput) => {
        expect(engine.query({ patterns: [ { graph } ] }).bindings).toHaveLength(1);
        for (const runtime of [ 'bun', 'node' ] as const) {
          expect(authoritySqlitePeerAdmission(runtime, operations.databasePath)).toBe(false);
        }
        const entries = [ ...input.requestedModes.entrySets() ];
        permissionPaths.push(...entries.map(([ id ]) => id.path));
        return new IdentifierMap(entries.map(([ id ]) => [ id, { [PERMISSIONS.Read]: true } ] as const));
      } } as never,
      authorizer: new PermissionBasedAuthorizer(),
      operationHandler: { handleSafe: async ({ request }: { request: IncomingMessage }) => {
        if (request.url === '/profile/card') { profileRequests += 1; }
        const bytes = request.url === '/profile/card' ? await readFile(profileFile) : Buffer.from('protected current data');
        return new OkResponseDescription(new RepresentationMetadata({ contentType: 'text/plain' }),
          guardStream(Readable.from([ bytes ])));
      } } as never,
    });
    const args: ParsingHttpHandlerArgs = {
      requestParser: { handleSafe: async (request: IncomingMessage) => ({ method: request.method!,
        target: { path: `https://root.invalid${request.url}` }, body: new BasicRepresentation() }) } as never,
      operationHandler: authorizing,
      responseWriter: new BasicResponseWriter(new ContentTypeMetadataWriter()),
      errorHandler: { handleSafe: async ({ error }: { error: { statusCode?: number; message?: string } }) => {
        errorsWritten += 1;
        return { statusCode: error.statusCode ?? 500,
          metadata: new RepresentationMetadata({ contentType: 'text/plain' }),
          data: guardStream(Readable.from([ error.message ?? 'error' ])) };
      } } as never,
    };
    const handler = new LocalPhysicalParsingHttpHandler(args, operations, credentials);
    server = createServer((request, response) => {
      completions.push(handler.handleSafe({ request: guardStream(request), response }).catch(error => {
        failures.push(error); response.destroy(error instanceof Error ? error : undefined);
      }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Owned HTTP listener has no address'); }
    origin = `http://127.0.0.1:${address.port}`;
    return { origin, operations, extraction, permissionPaths, failures,
      profileRequests: () => profileRequests, errorsWritten: () => errorsWritten,
      completed: async () => within(Promise.all(completions)), cleanup: async () => {
        server!.closeAllConnections();
        await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
        await within(Promise.all(completions));
        await engine.close();
        await rm(directory, { recursive: true, force: true });
      } };
  } catch (error) {
    server?.closeAllConnections(); server?.close();
    await engine.close(); await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

it('cold request credential preparation can dereference the same actual HTTP domain before protected permission admission', async () => {
  const context = await fixture();
  try {
    const response = await fetch(`${context.origin}/protected`, {
      headers: { Authorization: 'Bearer cold-fixture' }, signal: AbortSignal.timeout(8000),
    });
    expect(await response.text()).toBe('protected current data');
    expect(response.status).toBe(200);
    await context.completed();
    expect(context.profileRequests()).toBe(1);
    expect(context.extraction.get('/protected:Bearer cold-fixture')).toBe(1);
    expect(context.permissionPaths).toEqual([
      'https://root.invalid/profile/card', 'https://root.invalid/protected',
    ]);
    expect(context.failures).toEqual([]);
    expect(authoritySqlitePeerAdmission('node', context.operations.databasePath)).toBe(true);
  } finally { await context.cleanup(); }
}, 30_000);

it('rejected credentials use the CSS error path once and leave the domain available for a fresh healthy request', async () => {
  const context = await fixture();
  try {
    const denied = await fetch(`${context.origin}/protected`, {
      headers: { Authorization: 'Bearer refused-fixture' }, signal: AbortSignal.timeout(8000),
    });
    expect(denied.status).toBe(400);
    expect(await denied.text()).toBe('Fixture credential rejected');
    await context.completed();
    expect(context.extraction.get('/protected:Bearer refused-fixture')).toBe(1);
    expect(context.errorsWritten()).toBe(1);
    expect(context.permissionPaths).toEqual([]);
    expect(authoritySqlitePeerAdmission('bun', context.operations.databasePath)).toBe(true);
    const healthy = await fetch(`${context.origin}/protected`, { signal: AbortSignal.timeout(8000) });
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toBe('protected current data');
    await context.completed();
    expect(context.failures).toEqual([]);
  } finally { await context.cleanup(); }
}, 30_000);
