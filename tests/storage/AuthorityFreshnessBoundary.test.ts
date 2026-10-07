// B-owned contract test for the generic public derived-index freshness boundary.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import {
  AuthorityFreshnessService,
  AuthorityPendingFreshnessProvider,
  AuthorityPendingUnavailableError,
} from '../../src/storage/AuthorityFreshnessService';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import { SqliteSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';
import type { RdfNativeSparqlResult } from '../../src/storage/rdf/types';

const resource = 'http://root.invalid/alice/notes.ttl';
const other = 'http://root.invalid/alice/other.ttl';
const change = {
  path: 'alice/notes.ttl',
  resource,
  sourcePath: '/tmp/root.invalid/alice/notes.ttl',
  source: 'filesystem' as const,
  projection: 'direct' as const,
  type: 'updated' as const,
};
const workspace = { workspace: 'http://root.invalid/', cwd: '/tmp/root.invalid', projection: 'direct' as const, entries: [] };

async function withTmp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const parent = path.resolve('.test-data/authority-freshness-boundary');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'run-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('AuthorityPendingFreshnessProvider', () => {
  it('refuses the pending resource and its scope but not unrelated graphs', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      const provider = new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal));
      try {
        expect(() => provider.assertFresh({ graphUrls: [ resource ] })).not.toThrow();
        journal.recordAuthorityPending(change, workspace, 'v1');
        expect(() => provider.assertFresh({ graphUrls: [ resource ] }))
          .toThrow(AuthorityPendingUnavailableError);
        expect(() => provider.assertFresh({ resourceUrls: [ resource ] }))
          .toThrow(AuthorityPendingUnavailableError);
        expect(() => provider.assertFresh({ basePath: 'http://root.invalid/alice/' }))
          .toThrow(AuthorityPendingUnavailableError);
        expect(() => provider.assertFresh({ graphUrls: [ other ] })).not.toThrow();
      } finally {
        journal.close();
      }
    });
  });

  it('exposes a synchronous proof and conservatively refuses unbounded scope while pending', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      const provider = new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal));
      try {
        expect(typeof provider.assertFreshSync).toBe('function');
        expect(() => provider.assertFreshSync!({ graphUrls: [ resource ] })).not.toThrow();
        journal.recordAuthorityPending(change, workspace, 'v1');
        expect(() => provider.assertFreshSync!({ graphUrls: [ resource ] }))
          .toThrow(AuthorityPendingUnavailableError);
        expect(() => provider.assertFreshSync!({ unbounded: true }))
          .toThrow(AuthorityPendingUnavailableError);
        expect(() => provider.assertFreshSync!({ graphUrls: [ other ] })).not.toThrow();
      } finally {
        journal.close();
      }
    });
  });
});

describe('SolidRdfEngine synchronous embedded freshness', () => {
  const graphPattern = (graph: string) => ({
    patterns: [{ graph: DataFactory.namedNode(graph), subject: DataFactory.variable('s') }],
  });

  it('refuses a stale embedded query, preserves unrelated scope, and never calls an async-only provider', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      const engine = new SolidRdfEngine({ index: { path: path.join(dir, 'rdf.sqlite') } });
      engine.setAuthorityFreshnessProvider(
        new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal)),
      );
      await engine.open();
      try {
        expect(() => engine.query(graphPattern(resource))).not.toThrow();
        const op = journal.recordAuthorityPending(change, workspace, 'v1');
        expect(() => engine.query(graphPattern(resource))).toThrow(AuthorityPendingUnavailableError);
        expect(() => engine.query({ patterns: [] })).toThrow(AuthorityPendingUnavailableError);
        expect(() => engine.query(graphPattern(other))).not.toThrow();
        journal.clearAuthorityPending(op.id);
        expect(() => engine.query(graphPattern(resource))).not.toThrow();
      } finally {
        engine.close();
        journal.close();
      }
    });
  });

  it('refuses when the attached provider declares no synchronous capability, without invoking async', async () => {
    await withTmp(async dir => {
      const engine = new SolidRdfEngine({ index: { path: path.join(dir, 'rdf.sqlite') } });
      const assertFresh = vi.fn(async () => undefined);
      engine.setAuthorityFreshnessProvider({ assertFresh });
      try {
        expect(() => engine.query(graphPattern(resource))).toThrow(AuthorityPendingUnavailableError);
        expect(assertFresh).not.toHaveBeenCalled();
      } finally {
        engine.close();
      }
    });
  });
});

describe('SolidRdfEngine native freshness attachment', () => {
  function engineWithCount(dir: string): { engine: SolidRdfEngine; calls: () => number } {
    let count = 0;
    const client = {
      start: (): void => undefined,
      close: (): void => undefined,
      query: async (): Promise<RdfNativeSparqlResult> => {
        count += 1;
        return {
          status: 'ok',
          mediaType: 'application/sparql-results+json',
          body: JSON.stringify({ boolean: true }),
        };
      },
    };
    const engine = new SolidRdfEngine({ index: { path: path.join(dir, 'rdf.sqlite') }, nativeSparqlClient: client });
    return { engine, calls: () => count };
  }

  it('refuses a stale native answer while pending and serves it once the exact token is cleared', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      const { engine, calls } = engineWithCount(dir);
      engine.setAuthorityFreshnessProvider(
        new AuthorityPendingFreshnessProvider(new AuthorityFreshnessService(journal)),
      );
      const ask = `ASK { GRAPH <${resource}> { ?s ?p ?o } }`;
      const options = { basePath: 'http://root.invalid/alice/', operation: 'queryBoolean', acceptMediaType: 'application/sparql-results+json' };
      try {
        const op = journal.recordAuthorityPending(change, workspace, 'v1');
        await expect(engine.sparqlQuery(ask, options)).rejects.toMatchObject({ statusCode: 503 });
        expect(calls(), 'native client must not be reached while pending').toBe(0);

        journal.clearAuthorityPending(op.id);
        const result = await engine.sparqlQuery(ask, options);
        expect(result).toMatchObject({ status: 'ok' });
        expect(calls()).toBe(1);
      } finally {
        engine.close();
        journal.close();
      }
    });
  });
});
