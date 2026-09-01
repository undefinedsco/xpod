import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  BaseIdentifierStrategy,
  ExtensionBasedMapper,
  FileDataAccessor,
  IdentifierSetMultiMap,
  RepresentationMetadata,
  guardStream,
  type ResourceIdentifier,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import { PostgresRdfEngine } from '../../src/storage/rdf/PostgresRdfEngine';
import { QleverSparqlEngine } from '../../src/storage/rdf/QleverSparqlEngine';
import { SubgraphQueryEngine } from '../../src/storage/sparql/SubgraphQueryEngine';
import { MixDataAccessor } from '../../src/storage/accessors/MixDataAccessor';
import { SolidRdfDataAccessor } from '../../src/storage/accessors/SolidRdfDataAccessor';

const run = process.env.XPOD_RUN_NATIVE_RDF_PG_E2E === 'true' ? describe : describe.skip;
const image = process.env.XPOD_RDF_POSTGRES_IMAGE ?? 'xpod-rdf-postgres:pg17-dev';

function createNativeRdfEngine(connectionString: string): PostgresRdfEngine {
  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString,
    nativeSparqlEnabled: true,
  });
}

describe('native RDF product HTTP fixture contract', () => {
  it('enables native SPARQL before wiring the QLever adapter', () => {
    const engine = createNativeRdfEngine('postgres://postgres:xpod@127.0.0.1:5432/xpod');

    expect(engine.sparqlQuery).toBeTypeOf('function');
    expect(() => new QleverSparqlEngine(engine)).not.toThrow();
  });
});

run('native RDF product HTTP path', () => {
  const container = `xpod-native-rdf-product-http-${process.pid}`;
  let server: Server;
  let engine: PostgresRdfEngine;
  let sparqlEngine: QleverSparqlEngine;
  let origin: string;
  let publicGraph: string;
  let privateGraph: string;
  let workDir: string;
  let rdfFileMapper: ExtensionBasedMapper;
  let structuredAccessor: SolidRdfDataAccessor;

  beforeAll(async () => {
    docker('rm', '-f', container, { ignoreFailure: true });
    docker(
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=xpod',
      '-e', 'POSTGRES_DB=xpod',
      '-p', '127.0.0.1::5432',
      image,
    );
    await waitForPostgres(container);

    const postgresPort = docker('port', container, '5432/tcp').trim().split(':').at(-1);
    if (!postgresPort) {
      throw new Error('Docker did not publish the PostgreSQL port');
    }
    engine = createNativeRdfEngine(`postgres://postgres:xpod@127.0.0.1:${postgresPort}/xpod`);
    await engine.open();

    sparqlEngine = new QleverSparqlEngine(engine);
    const queryEngine = new SubgraphQueryEngine(sparqlEngine);
    const credentialsExtractor = {
      handleSafe: async (request: { headers: Record<string, string | string[] | undefined> }) => ({
        agent: { webId: String(request.headers['x-webid'] ?? 'anonymous') },
      }),
    };
    const permissionReader = {
      handleSafe: async () => new IdentifierSetMultiMap(),
    };
    const authorizer = {
      handleSafe: async ({ credentials, requestedModes }: any) => {
        const resource = [...requestedModes.keys()][0]?.path;
        if (credentials.agent?.webId === 'https://id.example/bob#me' && resource === privateGraph) {
          throw new Error('private graph denied');
        }
      },
    };
    let handler: SubgraphSparqlHttpHandler;
    server = createServer((request, response) => {
      void handler.handle({ request: request as any, response: response as any }).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('HTTP server did not expose a TCP address');
    }
    origin = `http://127.0.0.1:${address.port}`;
    publicGraph = `${origin}/alice/public.ttl`;
    privateGraph = `${origin}/alice/private.ttl`;

    workDir = await mkdtemp(path.join(tmpdir(), 'xpod-native-product-http-'));
    const localDataDir = path.join(workDir, 'data');
    await mkdir(localDataDir, { recursive: true });
    rdfFileMapper = new ExtensionBasedMapper(`${origin}/`, localDataDir);
    const fileAccessor = new FileDataAccessor(rdfFileMapper);
    structuredAccessor = new SolidRdfDataAccessor(
      engine,
      new TestIdentifierStrategy(`${origin}/`),
    );
    const updateAuthority = new MixDataAccessor(
      structuredAccessor,
      fileAccessor,
      false,
      true,
      fileAccessor,
      false,
      rdfFileMapper,
    );
    handler = new SubgraphSparqlHttpHandler(
      queryEngine,
      credentialsExtractor as any,
      permissionReader as any,
      authorizer as any,
      {},
      updateAuthority,
    );

    const writeGraph = async (graph: string, subject: string): Promise<void> => {
      const identifier = { path: graph };
      const metadata = new RepresentationMetadata(identifier);
      metadata.contentType = 'internal/quads';
      await updateAuthority.writeDocument(
        identifier,
        guardStream(Readable.from([
          DataFactory.quad(
            DataFactory.namedNode(subject),
            DataFactory.namedNode('urn:p'),
            DataFactory.namedNode('urn:o'),
          ),
        ])),
        metadata,
      );
    };
    await writeGraph(publicGraph, 'urn:public');
    await writeGraph(privateGraph, 'urn:private');
  }, 120_000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await structuredAccessor?.finalize();
    await engine?.close();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    docker('rm', '-f', container, { ignoreFailure: true });
  });

  it('keeps ACL/ACR-derived graph scope through HTTP, RDF engine, and the linked PostgreSQL runtime', async () => {
    const query = encodeURIComponent(`
      SELECT ?g ?s WHERE {
        GRAPH ?g { ?s <urn:p> <urn:o> }
      }
      ORDER BY ?g
    `);

    const alice = await fetch(`${origin}/alice/-/sparql?query=${query}`, {
      headers: { 'x-webid': 'https://id.example/alice#me' },
    });
    const bob = await fetch(`${origin}/alice/-/sparql?query=${query}`, {
      headers: { 'x-webid': 'https://id.example/bob#me' },
    });

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    const aliceBody = await alice.json() as any;
    const bobBody = await bob.json() as any;
    expect(aliceBody.results.bindings.map((row: any) => row.s.value)).toEqual([
      'urn:private',
      'urn:public',
    ]);
    expect(bobBody.results.bindings.map((row: any) => row.s.value)).toEqual([
      'urn:public',
    ]);
  });

  it('applies the same access scope to ASK and CONSTRUCT', async () => {
    const ask = encodeURIComponent(`ASK { GRAPH <${privateGraph}> { ?s <urn:p> <urn:o> } }`);
    const construct = encodeURIComponent(`
      CONSTRUCT { ?s <urn:visible> ?o }
      WHERE { GRAPH ?g { ?s <urn:p> ?o } }
    `);

    const aliceAsk = await fetch(`${origin}/alice/-/sparql?query=${ask}`, {
      headers: { 'x-webid': 'https://id.example/alice#me' },
    });
    const bobAsk = await fetch(`${origin}/alice/-/sparql?query=${ask}`, {
      headers: { 'x-webid': 'https://id.example/bob#me' },
    });
    const bobConstruct = await fetch(`${origin}/alice/-/sparql?query=${construct}`, {
      headers: {
        accept: 'application/n-triples',
        'x-webid': 'https://id.example/bob#me',
      },
    });

    const aliceAskText = await aliceAsk.text();
    const bobAskText = await bobAsk.text();
    expect(aliceAsk.status, aliceAskText).toBe(200);
    expect(bobAsk.status, bobAskText).toBe(200);
    expect(JSON.parse(aliceAskText).boolean).toBe(true);
    expect(JSON.parse(bobAskText).boolean).toBe(false);
    expect(bobConstruct.status).toBe(200);
    const graph = await bobConstruct.text();
    expect(graph).toContain('<urn:public> <urn:visible> <urn:o> .');
    expect(graph).not.toContain('urn:private');
  });

  it('keeps UPDATE WHERE reads inside the ACL/ACR scope', async () => {
    const update = (subject: string) => `
      INSERT { GRAPH <${publicGraph}> { <${subject}> <urn:p> ?o } }
      WHERE { GRAPH <${privateGraph}> { ?s <urn:p> ?o } }
    `;
    const post = (webId: string, body: string) => fetch(`${origin}/alice/-/sparql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-update',
        'x-webid': webId,
      },
      body,
    });

    const denied = await post('https://id.example/bob#me', update('urn:denied-copy'));
    const allowed = await post('https://id.example/alice#me', update('urn:allowed-copy'));
    const deniedText = await denied.text();
    const allowedText = await allowed.text();
    expect(denied.status, deniedText).toBe(204);
    expect(allowed.status, allowedText).toBe(204);

    const verify = encodeURIComponent(`
      SELECT ?s WHERE {
        GRAPH <${publicGraph}> { ?s <urn:p> <urn:o> }
        FILTER(?s IN (<urn:denied-copy>, <urn:allowed-copy>))
      }
      ORDER BY ?s
    `);
    const response = await fetch(`${origin}/alice/-/sparql?query=${verify}`, {
      headers: { 'x-webid': 'https://id.example/bob#me' },
    });
    const body = await response.json() as any;
    expect(body.results.bindings.map((row: any) => row.s.value)).toEqual([
      'urn:allowed-copy',
    ]);
    const publicFile = await rdfFileMapper.mapUrlToFilePath(
      { path: publicGraph },
      false,
      'text/turtle',
    );
    const localAuthority = await readFile(publicFile.filePath, 'utf8');
    expect(localAuthority).toContain('urn:allowed-copy');
    expect(localAuthority).not.toContain('urn:denied-copy');
  });
});

class TestIdentifierStrategy extends BaseIdentifierStrategy {
  public constructor(private readonly baseUrl: string) {
    super();
  }

  public supportsIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith(this.baseUrl);
  }

  public isRootContainer(identifier: ResourceIdentifier): boolean {
    return identifier.path === this.baseUrl;
  }
}

function docker(...input: Array<string | { ignoreFailure?: boolean }>): string {
  const options = typeof input.at(-1) === 'object' ? input.pop() as { ignoreFailure?: boolean } : {};
  try {
    return execFileSync('docker', input as string[], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
  } catch (error) {
    if (options.ignoreFailure) {
      return '';
    }
    throw error;
  }
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const logs = docker('logs', container);
      if (!logs.includes('PostgreSQL init process complete; ready for start up.')) {
        throw new Error('PostgreSQL init scripts are still running');
      }
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'xpod');
      const runtimeReady = docker(
        'exec', container, 'psql', '-U', 'postgres', '-d', 'xpod', '-Atc',
        "SELECT xpod_rdf.native_sparql_capabilities()->>'ready'",
      ).trim();
      if (runtimeReady !== 'true') {
        throw new Error(`Native SPARQL ABI is not ready: ${runtimeReady}`);
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('PostgreSQL did not become ready');
}
