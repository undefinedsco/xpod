import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import {
  applyRdfAccessScope,
  PostgresRdfEngine,
  RdfQuadIndex,
  SolidRdfEngine,
  rdfVar,
  type RdfEngineLike,
  type RdfQueryResult,
  type RdfSourceInput,
} from '../../../src/storage/rdf';

const { literal, namedNode, quad } = DataFactory;

const GRAPH = namedNode('https://pod.example/alice/.data/shared/source-scope.ttl');
const LABEL = namedNode('http://www.w3.org/2000/01/rdf-schema#label');
const BASE_SCOPE = {
  basePath: 'https://pod.example/alice/.data/',
  mode: 'read' as const,
  principal: 'https://id.example/alice/profile/card#me',
  version: 'acl-v1',
};

type TestEngine = RdfEngineLike & {
  root: string;
};

interface EngineFactory {
  name: string;
  create(): Promise<TestEngine>;
}

const SOURCES = {
  allowed: 'https://pod.example/alice/.data/imports/allowed.nt',
  denied: 'https://pod.example/alice/.data/imports/denied.nt',
  deniedPrefix: 'https://pod.example/alice/.data/private/imports/prefix.nt',
};

const engineFactories: EngineFactory[] = [
  {
    name: 'SolidRdfEngine SQLite',
    async create(): Promise<TestEngine> {
      const root = await mkdtemp(path.join(tmpdir(), 'xpod-rdf-source-scope-sqlite-'));
      const index = new RdfQuadIndex({ path: path.join(root, 'rdf.sqlite') });
      const engine = new SolidRdfEngine({ index });
      await engine.open();
      return Object.assign(engine, { root });
    },
  },
  {
    name: 'PostgresRdfEngine PGlite',
    async create(): Promise<TestEngine> {
      const root = await mkdtemp(path.join(tmpdir(), 'xpod-rdf-source-scope-pglite-'));
      const engine = new PostgresRdfEngine({
        driver: 'pglite',
        dataDir: root,
      });
      await engine.open();
      return Object.assign(engine, { root });
    },
  },
];

describe.each(engineFactories)('RDF source access scope on graph patterns ($name)', ({ create }) => {
  it('allows only quads from allowedSourceUrls when graph IRIs are identical', async () => {
    const engine = await create();
    try {
      await seedSourceScopedQuads(engine);

      const result = await queryLabels(engine, {
        ...BASE_SCOPE,
        allowedSourceUrls: [SOURCES.allowed],
      });

      expect(result).toEqual(['allowed']);
    } finally {
      await closeAndRemove(engine);
    }
  });

  it('does not leak source-less quads under allowedSourceUrls', async () => {
    const engine = await create();
    try {
      await seedSourceScopedQuads(engine);

      const result = await queryLabels(engine, {
        ...BASE_SCOPE,
        allowedSourceUrls: [SOURCES.allowed],
      });

      expect(result).not.toContain('source-less');
    } finally {
      await closeAndRemove(engine);
    }
  });

  it('excludes quads from deniedSourceUrls while keeping other same-graph sources', async () => {
    const engine = await create();
    try {
      await seedSourceScopedQuads(engine);

      const result = await queryLabels(engine, {
        ...BASE_SCOPE,
        deniedSourceUrls: [SOURCES.denied],
      });

      expect(result).toEqual(['allowed', 'prefix-denied', 'source-less']);
    } finally {
      await closeAndRemove(engine);
    }
  });

  it('excludes quads from deniedSourcePrefixes while keeping other same-graph sources', async () => {
    const engine = await create();
    try {
      await seedSourceScopedQuads(engine);

      const result = await queryLabels(engine, {
        ...BASE_SCOPE,
        deniedSourcePrefixes: ['https://pod.example/alice/.data/private/'],
      });

      expect(result).toEqual(['allowed', 'denied', 'source-less']);
    } finally {
      await closeAndRemove(engine);
    }
  });
});

it('applies source ACLs to every nested graph-pattern group', () => {
  const pattern = {
    graph: GRAPH,
    subject: rdfVar('entity'),
    predicate: LABEL,
    object: rdfVar('label'),
  };
  const scoped = applyRdfAccessScope({
    patterns: [pattern],
    unions: [{ branches: [{ patterns: [pattern] }] }],
    optional: [{
      patterns: [pattern],
      minus: [{ patterns: [pattern] }],
      exists: [{ patterns: [pattern] }],
    }],
    minus: [{ patterns: [pattern] }],
    exists: [{ patterns: [pattern] }],
  }, {
    ...BASE_SCOPE,
    allowedSourceUrls: [SOURCES.allowed],
  });
  const optional = scoped.optional?.[0];
  if (!optional || Array.isArray(optional)) {
    throw new Error('expected a structured optional group');
  }

  const nestedPatterns = [
    scoped.patterns?.[0],
    scoped.unions?.[0].branches[0].patterns[0],
    optional.patterns[0],
    optional.minus?.[0].patterns[0],
    optional.exists?.[0].patterns[0],
    scoped.minus?.[0].patterns[0],
    scoped.exists?.[0].patterns[0],
  ];
  for (const nestedPattern of nestedPatterns) {
    expect(nestedPattern?.sourceScope).toEqual({ allowedSources: [SOURCES.allowed] });
  }
});

async function seedSourceScopedQuads(engine: RdfEngineLike): Promise<void> {
  await engine.replaceSource([
    labelledQuad('allowed', 'allowed'),
  ], sourceInput(SOURCES.allowed, 'imports/allowed.nt'));
  await engine.replaceSource([
    labelledQuad('denied', 'denied'),
  ], sourceInput(SOURCES.denied, 'imports/denied.nt'));
  await engine.replaceSource([
    labelledQuad('prefix-denied', 'prefix-denied'),
  ], sourceInput(SOURCES.deniedPrefix, 'private/imports/prefix.nt'));
  await engine.put(labelledQuad('source-less', 'source-less'));
}

async function queryLabels(
  engine: RdfEngineLike,
  accessScope: Parameters<typeof applyRdfAccessScope>[1],
): Promise<string[]> {
  const result = await engine.query(applyRdfAccessScope({
    patterns: [{
      graph: GRAPH,
      subject: rdfVar('entity'),
      predicate: LABEL,
      object: rdfVar('label'),
    }],
    select: ['label'],
    orderBy: [{ variable: 'label' }],
  }, accessScope)) as RdfQueryResult;

  return result.bindings.map((binding) => binding.label.value);
}

function labelledQuad(entity: string, label: string) {
  return quad(
    namedNode(`${GRAPH.value}#${entity}`),
    LABEL,
    literal(label),
    GRAPH,
  );
}

function sourceInput(source: string, localPath: string): RdfSourceInput {
  return {
    source,
    workspace: 'https://pod.example/alice/.data/',
    localPath,
    contentType: 'application/n-triples',
    sourceVersion: 'v1',
  };
}

async function closeAndRemove(engine: TestEngine): Promise<void> {
  await engine.close();
  await rm(engine.root, { recursive: true, force: true });
}
