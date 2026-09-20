/**
 * Throwaway-instance probe: a `/-/sparql` write must reach a real notification channel.
 *
 * Boots a temporary Community Solid Server (no live Pod, no repo config):
 *   - `css:config/file.json` (file backend + the full notification stack: MonitoringStore,
 *     ListeningActivityHandler, WebSocketChannel2023)
 *   - a PermissionReader override (`AllStaticReader`) so the probe needs no credentials
 *   - the real `SubgraphSparqlHttpHandler` from this repo, wired into the HTTP waterfall with the
 *     same `emitter` (`urn:solid-server:default:ResourceStore`) the notification stack listens to
 *
 * The handler's `updateAuthority` is replaced at runtime by `ProbeSparqlUpdateAuthority`, which
 * applies the rewritten update straight to the CSS `FileDataAccessor`. That reproduces the
 * production topology this probe is about: `MixDataAccessor.executeSparqlUpdate` also writes below
 * the `ResourceStore` chain, so nothing but the handler's activity can inform the channel.
 *
 * Run from the repository root:
 *   bun scripts/probe-sparql-notification.ts
 *
 * Temp data lives in `.test-data/sparql-notification-probe*` and is removed on exit; the transcript
 * is kept in `.test-data/sparql-notification-probe/transcript.log`.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DataFactory, Parser as N3Parser, Writer as N3Writer } from 'n3';
import type { Quad } from 'n3';
import { Parser as SparqlParser } from 'sparqljs';
import type { DataAccessor, ResourceIdentifier } from '@solid/community-server';
import { NotFoundHttpError, RepresentationMetadata } from '@solid/community-server';
import { ensureBunCommunitySolidServerJwkCompat, ensureBunUndiciCompat } from '../src/runtime/compat/ensureBunUndiciCompat';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const LOG_DIR = path.join(REPO_ROOT, '.test-data', 'sparql-notification-probe');
const LOG_FILE = path.join(LOG_DIR, 'transcript.log');
const NOTIFICATION_TYPE = 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023';
const NOTIFICATION_CONTEXT = 'https://www.w3.org/ns/solid/notification/v1';

const lines: string[] = [];
let failures = 0;

function record(message: string): void {
  lines.push(message);
  console.log(message);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    record(`  PASS  ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    failures += 1;
    record(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Browser-style WebSocket client (Bun global) that queues messages and can await the next one. */
function openSocket(url: string): {
  open: () => Promise<void>;
  nextMessage: (timeoutMs: number) => Promise<string | undefined>;
  messages: string[];
  close: () => void;
} {
  const messages: string[] = [];
  let waiter: ((message: string) => void) | undefined;
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event: MessageEvent) => {
    const data = typeof event.data === 'string' ? event.data : String(event.data);
    const pending = waiter;
    if (pending) {
      // Hand the message to the awaiting reader only; it must not stay queued as well.
      waiter = undefined;
      pending(data);
      return;
    }
    messages.push(data);
  });
  return {
    messages,
    open: () => new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error(`WebSocket error for ${url}`)));
    }),
    nextMessage: (timeoutMs: number) => {
      const queued = messages.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          resolve(undefined);
        }, timeoutMs);
        waiter = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
    close: () => socket.close(),
  };
}

/**
 * Probe-only write authority: applies the handler's rewritten SPARQL update directly to the CSS
 * accessor, i.e. below the `ResourceStore` chain, exactly like `MixDataAccessor` does in production.
 */
class ProbeSparqlUpdateAuthority {
  public constructor(private readonly accessor: DataAccessor) {}

  /** The handler probes pre-update existence through the write authority (same accessor). */
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    return await this.accessor.getMetadata(identifier);
  }

  public async executeSparqlUpdate(query: string, baseIri: string): Promise<void> {
    record(`  [authority] applying rewritten update below the store chain: ${query.replace(/\s+/g, ' ').trim()}`);
    try {
      await this.apply(query, baseIri);
    } catch (error) {
      record(`  [authority] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }
  }

  private async apply(query: string, baseIri: string): Promise<void> {
    const parsed = new SparqlParser({ baseIRI: baseIri }).parse(query) as unknown as {
      updates?: { type?: string; updateType?: string; graph?: { value?: string }; insert?: any[]; delete?: any[] }[];
    };
    const perGraph = new Map<string, { insert: Quad[]; delete: Quad[]; clearAll: boolean }>();
    const bucket = (graph: string): { insert: Quad[]; delete: Quad[]; clearAll: boolean } => {
      const existing = perGraph.get(graph) ?? { insert: [], delete: [], clearAll: false };
      perGraph.set(graph, existing);
      return existing;
    };

    for (const operation of parsed.updates ?? []) {
      if (operation.type === 'create' && operation.graph?.value) {
        bucket(operation.graph.value);
        continue;
      }
      const blocks: { name?: { value: string }; triples?: any[] }[] = [
        ...(operation.insert ?? []),
        ...(operation.delete ?? []),
      ];
      const isDelete = Boolean(operation.delete?.length) || operation.updateType === 'deletewhere';
      for (const block of blocks) {
        const graph = block.name?.value ?? baseIri;
        const target = bucket(graph);
        for (const triple of block.triples ?? []) {
          if (triple.subject?.termType === 'Variable' || triple.predicate?.termType === 'Variable' || triple.object?.termType === 'Variable') {
            // `DELETE WHERE { GRAPH <g> { ?s ?p ?o } }` (the CLEAR/DROP rewrite) removes everything.
            target.clearAll = true;
            continue;
          }
          const quad = toDocumentQuad(DataFactory.quad(triple.subject, triple.predicate, triple.object, DataFactory.namedNode(graph)));
          (isDelete ? target.delete : target.insert).push(quad);
        }
      }
    }

    for (const [graph, change] of perGraph) {
      const identifier = { path: graph };
      const next = new Map<string, Quad>();
      if (!change.clearAll) {
        for (const quad of await this.readQuads(identifier)) {
          next.set(quadKey(quad), quad);
        }
      }
      for (const quad of change.delete) {
        next.delete(quadKey(quad));
      }
      for (const quad of change.insert) {
        next.set(quadKey(quad), quad);
      }
      await this.writeQuads(identifier, [ ...next.values() ]);
      record(`  [authority] ${identifier.path} now holds ${next.size} quad(s)`);
    }
  }

  private async readQuads(identifier: ResourceIdentifier): Promise<Quad[]> {
    try {
      const data = await this.accessor.getData(identifier);
      const quads = new N3Parser({ baseIRI: identifier.path }).parse(await streamToString(data));
      // Document files hold default-graph triples; the graph IRI only exists inside the store.
      return quads.map(toDocumentQuad);
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        return [];
      }
      throw error;
    }
  }

  private async writeQuads(identifier: ResourceIdentifier, quads: Quad[]): Promise<void> {
    const writer = new N3Writer({ format: 'Turtle' });
    writer.addQuads(quads);
    const text = await new Promise<string>((resolve, reject) => {
      writer.end((error: Error | null, result: string) => (error ? reject(error) : resolve(result)));
    });
    await this.accessor.writeDocument(identifier, Readable.from([ text ]), documentMetadata(identifier));
  }
}

/**
 * Metadata for a plain `text/turtle` document write.
 *
 * Only the content type is set: the file accessor then stores no `.meta` sidecar (same as a normal
 * LDP write of a supported content type), and reads derive `dc:modified` from the data file mtime,
 * which is what the notification generators turn into the notification `state` (ETag).
 * Built through CSS' own `RepresentationMetadata` because this repo has a second, incompatible `n3`.
 */
function documentMetadata(identifier: ResourceIdentifier): RepresentationMetadata {
  const metadata = new RepresentationMetadata(identifier);
  metadata.contentType = 'text/turtle';
  return metadata;
}

/** Writes document files as default-graph triples, like `MixDataAccessor.writeLocalRdfAuthority` does. */
function toDocumentQuad(quad: Quad): Quad {
  return DataFactory.quad(quad.subject, quad.predicate, quad.object);
}

function quadKey(quad: Quad): string {
  return `${quad.subject.value}|${quad.predicate.value}|${quad.object.value}`;
}

function probeConfig(): unknown {
  return {
    '@context': [
      'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^8.0.0/components/context.jsonld',
      'https://linkedsoftwaredependencies.org/bundles/npm/@undefineds.co/xpod/^0.0.0/components/context.jsonld',
      'https://linkedsoftwaredependencies.org/bundles/npm/asynchronous-handlers/^1.0.0/components/context.jsonld',
    ],
    import: [ 'css:config/file.json' ],
    '@graph': [
      {
        comment: 'DO NOT USE IN PRODUCTION: the probe grants every permission so it needs no credentials.',
        '@type': 'Override',
        overrideInstance: { '@id': 'urn:solid-server:default:PermissionReader' },
        overrideParameters: { '@type': 'AllStaticReader', allow: true },
      },
      {
        '@id': 'urn:probe:SubgraphSparqlHttpHandler',
        '@type': 'SubgraphSparqlHttpHandler',
        comment: 'The real Xpod handler; `emitter` is the same MonitoringStore the notification stack listens to.',
        queryEngine: { '@id': 'urn:probe:ProbeQueryEngine' },
        credentialsExtractor: { '@id': 'urn:solid-server:default:CredentialsExtractor' },
        permissionReader: { '@id': 'urn:solid-server:default:PermissionReader' },
        authorizer: { '@id': 'urn:solid-server:default:Authorizer' },
        emitter: { '@id': 'urn:solid-server:default:ResourceStore' },
      },
      {
        '@id': 'urn:probe:ProbeQueryEngine',
        comment: 'Placeholder for SIDE-effect-free construction; the probe never exercises read paths.',
        '@type': 'MemoryMapStorage',
      },
      {
        comment: 'Serve the SPARQL sidecar; everything else keeps the file.json behaviour.',
        '@type': 'Override',
        overrideInstance: { '@id': 'urn:solid-server:default:BaseHttpHandler' },
        overrideParameters: {
          '@type': 'StatusWaterfallHandler',
          handlers: [
            { '@id': 'urn:probe:SubgraphSparqlHttpHandler' },
            { '@id': 'urn:solid-server:default:StaticAssetHandler' },
            { '@id': 'urn:solid-server:default:OidcHandler' },
            { '@id': 'urn:solid-server:default:NotificationHttpHandler' },
            { '@id': 'urn:solid-server:default:StorageDescriptionHandler' },
            { '@id': 'urn:solid-server:default:AuthResourceHttpHandler' },
            { '@id': 'urn:solid-server:default:IdentityProviderHandler' },
            { '@id': 'urn:solid-server:default:LdpHandler' },
          ],
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(LOG_FILE, '');
  record('== throwaway-instance probe: /-/sparql write -> WebSocketChannel2023 notification ==');

  const dataRoot = await mkdtemp(path.join(REPO_ROOT, '.test-data', 'sparql-notification-probe-'));
  const configPath = path.join(dataRoot, 'probe-config.json');
  await writeFile(configPath, JSON.stringify(probeConfig(), null, 2));

  const port = await freePort();
  const baseUrl = `http://localhost:${port}/`;
  const dataPath = path.join(dataRoot, 'data');
  record(`[1] instance   : baseUrl=${baseUrl} dataRoot=${dataRoot}`);

  ensureBunUndiciCompat(REPO_ROOT);
  const css = await import('@solid/community-server');
  ensureBunCommunitySolidServerJwkCompat(css);

  const runner = new css.AppRunner() as unknown as {
    createComponentsManager(loaderProperties: unknown, configs: string[]): Promise<any>;
    createCliResolver(componentsManager: any): Promise<{ shorthandResolver: unknown }>;
    resolveShorthand(shorthandResolver: unknown, shorthand: unknown): Promise<Record<string, unknown>>;
    createApp(componentsManager: any, variables: unknown): Promise<{ start(): Promise<void>; stop(): Promise<void> }>;
  };
  const loaderProperties = {
    mainModulePath: REPO_ROOT,
    typeChecking: false,
    dumpErrorState: false,
    logLevel: 'error',
  };
  const componentsManager = await runner.createComponentsManager(loaderProperties, [ configPath ]);
  // Resolve the CSS variables through the regular shorthand path so every default (workers, socket, ...) is filled in.
  const cliResolver = await runner.createCliResolver(componentsManager);
  const variables = await runner.resolveShorthand(cliResolver.shorthandResolver, {
    baseUrl,
    port,
    rootFilePath: dataPath,
    loggingLevel: 'error',
  });
  record(`[1b] variables : port=${variables['urn:solid-server:default:variable:port']} rootFilePath=${variables['urn:solid-server:default:variable:rootFilePath']}`);

  const handler = await componentsManager.instantiate('urn:probe:SubgraphSparqlHttpHandler', { variables }) as {
    updateAuthority?: unknown;
    emitter?: unknown;
  };
  const fileAccessor = await componentsManager.instantiate('urn:solid-server:default:FileDataAccessor', { variables }) as DataAccessor;
  handler.updateAuthority = new ProbeSparqlUpdateAuthority(fileAccessor);

  const app = await runner.createApp(componentsManager, variables);
  await app.start();
  record('[2] app started (css:config/file.json + SubgraphSparqlHttpHandler + AllStaticReader)');

  const sockets: { close: () => void }[] = [];
  try {
    const documentA = `${baseUrl}alice/a.ttl`;
    const documentB = `${baseUrl}alice/b.ttl`;

    for (const document of [ documentA, documentB ]) {
      const put = await fetch(document, {
        method: 'PUT',
        headers: { 'content-type': 'text/turtle' },
        body: `<#s> <#p> "initial ${document}" .\n`,
      });
      record(`[3] PUT ${new URL(document).pathname} -> ${put.status} ${put.headers.get('location') ?? ''}`.trimEnd());
    }

    async function subscribe(topic: string): Promise<{ receiveFrom: string; id: string; socket: ReturnType<typeof openSocket> }> {
      const response = await fetch(`${baseUrl}.notifications/WebSocketChannel2023/`, {
        method: 'POST',
        headers: { 'content-type': 'application/ld+json', accept: 'application/ld+json' },
        body: JSON.stringify({ '@context': NOTIFICATION_CONTEXT, type: NOTIFICATION_TYPE, topic }),
      });
      const body = await response.json() as { receiveFrom?: string; id?: string };
      record(`[4] POST /.notifications/WebSocketChannel2023/ topic=${new URL(topic).pathname} -> ${response.status}`);
      record(`    channel    : ${JSON.stringify(body)}`);
      if (!response.ok || !body.receiveFrom) {
        throw new Error(`subscription failed: ${response.status} ${JSON.stringify(body)}`);
      }
      const socket = openSocket(body.receiveFrom);
      await socket.open();
      sockets.push(socket);
      record(`    socket open: ${body.receiveFrom}`);
      return { receiveFrom: body.receiveFrom, id: body.id ?? '', socket };
    }

    const subscriptionA = await subscribe(documentA);

    // --- control: the pre-fix topology (handler writes with no activity emitter) ---------------
    handler.emitter = undefined;
    record('[5] control    : emitter detached (pre-fix topology), POST /alice/a.ttl/-/sparql');
    const controlWrite = await fetch(`${documentA}/-/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: 'INSERT DATA { <#s> <#control> "detached" }',
    });
    record(`    response   : ${controlWrite.status} (body: ${JSON.stringify((await controlWrite.text()).slice(0, 120))})`);
    const controlMessage = await subscriptionA.socket.nextMessage(1500);
    check('pre-fix topology delivers no notification for a .sparql write', controlMessage === undefined,
      controlMessage === undefined ? 'no message in 1500ms' : `unexpected message: ${controlMessage}`);

    // --- fixed topology ------------------------------------------------------------------------
    handler.emitter = await componentsManager.instantiate('urn:solid-server:default:ResourceStore', { variables });
    record('[6] fixed      : emitter attached (urn:solid-server:default:ResourceStore), POST /alice/a.ttl/-/sparql');
    const writeOne = await fetch(`${documentA}/-/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: 'INSERT DATA { <#s> <#p2> "two" }',
    });
    record(`    response   : ${writeOne.status} (body: ${JSON.stringify((await writeOne.text()).slice(0, 120))})`);
    const notificationA = await subscriptionA.socket.nextMessage(5000);
    record(`    notification (verbatim): ${notificationA ?? '<none within 5000ms>'}`);
    check('a .sparql write reaches the subscribed channel', notificationA !== undefined);
    if (notificationA) {
      const parsed = JSON.parse(notificationA) as { type?: string; object?: string; target?: string; state?: string };
      check('notification type is a change activity', parsed.type === 'Update' || parsed.type === 'Create', `type=${parsed.type}`);
      check('notification object is the written document', parsed.object === documentA, `object=${parsed.object}`);
    }

    // --- untouched document stays silent, and its own write still notifies ---------------------
    const subscriptionB = await subscribe(documentB);
    record('[7] silence    : POST /alice/a.ttl/-/sparql again; /alice/b.ttl must stay silent');
    const writeTwo = await fetch(`${documentA}/-/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: 'INSERT DATA { <#s> <#p3> "three" }',
    });
    record(`    response   : ${writeTwo.status}`);
    const notificationA2 = await subscriptionA.socket.nextMessage(3000);
    check('subscribed document receives the second write', notificationA2 !== undefined);
    const silentB = await subscriptionB.socket.nextMessage(1500);
    check('untouched document receives nothing', silentB === undefined,
      silentB === undefined ? 'no message in 1500ms' : `unexpected message: ${silentB}`);

    record('[8] positive control: POST /alice/b.ttl/-/sparql must notify the b.ttl channel');
    const writeB = await fetch(`${documentB}/-/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: 'INSERT DATA { <#s> <#p> "b" }',
    });
    record(`    response   : ${writeB.status}`);
    const notificationB = await subscriptionB.socket.nextMessage(5000);
    record(`    notification (verbatim): ${notificationB ?? '<none within 5000ms>'}`);
    check('the silent channel was live all along', notificationB !== undefined);
    const untouchedA = await subscriptionA.socket.nextMessage(1000);
    check('writing b.ttl does not notify the a.ttl channel', untouchedA === undefined,
      untouchedA === undefined ? 'no message in 1000ms' : `unexpected message: ${untouchedA}`);

    record('[8b] create case: subscribe to a not-yet-existing document, then create it through .sparql');
    const documentC = `${baseUrl}alice/c.ttl`;
    const subscriptionC = await subscribe(documentC);
    const writeC = await fetch(`${documentC}/-/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'application/sparql-update' },
      body: 'INSERT DATA { <#s> <#p> "created by the sidecar" }',
    });
    record(`    response   : ${writeC.status}`);
    const notificationC = await subscriptionC.socket.nextMessage(5000);
    record(`    notification (verbatim): ${notificationC ?? '<none within 5000ms>'}`);
    check('creating a document through .sparql notifies as a create', notificationC !== undefined);
    if (notificationC) {
      const parsed = JSON.parse(notificationC) as { type?: string; object?: string };
      check('create notification carries type Create', parsed.type === 'Create', `type=${parsed.type}`);
      check('create notification object is the new document', parsed.object === documentC, `object=${parsed.object}`);
    }
    const created = await fetch(documentC, { headers: { accept: 'text/turtle' } });
    record(`    GET ${new URL(documentC).pathname} -> ${created.status} ${JSON.stringify((await created.text()).replace(/\s+/g, ' ').trim())}`);
    check('the created document is readable through the store', created.status === 200);
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // teardown only
      }
    }
    await app.stop();
    record('[9] app stopped');
    if (process.env.PROBE_KEEP_TEMP === '1') {
      record(`[10] temp root kept (PROBE_KEEP_TEMP=1): ${dataRoot}`);
    } else {
      await rm(dataRoot, { recursive: true, force: true });
      record(`[10] temp root removed: ${dataRoot}`);
    }
    record(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} failed check(s))`);
    await appendFile(LOG_FILE, `${lines.join('\n')}\n`);
    record(`transcript: ${LOG_FILE}`);
  }
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
