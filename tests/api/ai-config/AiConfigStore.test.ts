import { describe, expect, it, vi } from 'vitest';
import { drizzle, type AnyPodTable, type PodColumn } from '@undefineds.co/drizzle-solid';
import { aiConfigResource, aiModelResource } from '@undefineds.co/models';
import { aiConfigModelRef } from '@undefineds.co/models/ai-config';
import { handlerRegistry, type Triple } from '../../../node_modules/@undefineds.co/drizzle-solid/dist/core/triple/index.js';
import { Parser as SparqlParser } from 'sparqljs';
import { xpodAiConfigResource } from '../../../src/api/ai-config/XpodAiConfigSchema';
import { DrizzlePodAiConfigStore } from '../../../src/api/ai-config/AiConfigStore';

const owner = {
  webId: 'https://id.example/alice/profile/card#me',
  podUrl: 'https://storage.example/alice/',
};
const auth = {
  type: 'solid' as const,
  webId: owner.webId,
  accessToken: 'solid-token',
  tokenType: 'Bearer' as const,
};
const cloudOwnerLocalPod = {
  webId: 'http://cloud.localhost:16300/accept-web/profile/card#me',
  podUrl: 'https://acceptance-local.nodes.acceptance.test/accept-web/',
};
const cloudAuth = {
  type: 'solid' as const,
  webId: cloudOwnerLocalPod.webId,
  accessToken: 'solid-token',
  tokenType: 'DPoP' as const,
};

describe('DrizzlePodAiConfigStore', () => {
  it('round-trips model assignments through installed INSERT/UPDATE RDF as canonical NamedNodes', async () => {
    const fixture = createRdfDatabase();
    const store = createStore(fixture.database);
    const relative = aiConfigModelRef('openai', 'fixture-gpt-acceptance');
    const canonical = aiModelResource.buildIri(owner.podUrl, { id: aiModelResource.parseRef(relative)!.resourceId });
    const inserted = await store.update({ ...owner, patch: { models: { chatModel: relative } } });
    expect(fixture.modelTerms('chatModel')).toEqual([{ termType: 'NamedNode', value: canonical }]);
    expect(inserted.models.chatModel).toBe(canonical);
    expect((await store.read(owner)).models.chatModel).toBe(canonical);

    const replacement = aiConfigModelRef('openai', 'next-chat');
    const replacementIri = aiModelResource.buildIri(owner.podUrl, { id: aiModelResource.parseRef(replacement)!.resourceId });
    const updated = await store.update({ ...owner, patch: { models: { chatModel: replacement } } });
    expect(fixture.modelTerms('chatModel')).toEqual([{ termType: 'NamedNode', value: replacementIri }]);
    expect(updated.models.chatModel).toBe(replacementIri);
    expect((await store.read(owner)).models.chatModel).toBe(replacementIri);
    await store.update({ ...owner, patch: { models: { chatModel: null } } });
    expect(fixture.modelTerms('chatModel')).toEqual([]);
    expect((await store.read(owner)).models).toEqual({});
    expect(fixture.queries.every(query => !query.includes('fastModel'))).toBe(true);
  });

  it('preserves external absolute IRI lexical identity and untouched assignments', async () => {
    const fixture = createRdfDatabase();
    const store = createStore(fixture.database);
    const external = 'https://EXTERNAL.example/a/../model#chat';
    await store.update({ ...owner, patch: { models: { chatModel: external, readerModel: 'openai.ttl#reader' } } });
    const canonicalReader = aiModelResource.buildIri(owner.podUrl, { id: 'openai.ttl#reader' });
    expect((await store.read(owner)).models).toEqual({ chatModel: external, readerModel: canonicalReader });
    await store.update({ ...owner, patch: { models: { chatModel: null } } });
    expect((await store.read(owner)).models).toEqual({ readerModel: canonicalReader });
  });

  it('leaves already-broken absolute references unchanged for explicit reselection', async () => {
    const fixture = createRdfDatabase();
    const store = createStore(fixture.database);
    const broken = 'https://storage.example/alice/settings/providers/settings/providers/openai.ttl#chat';
    await store.update({ ...owner, patch: { models: { chatModel: broken } } });
    expect((await store.read(owner)).models.chatModel).toBe(broken);
  });

  it('rejects incomplete model references before writing instead of silently dropping them', async () => {
    const fixture = createRdfDatabase();
    await expect(createStore(fixture.database).update({ ...owner, patch: { models: { chatModel: 'linx' } } })).rejects.toThrow();
    expect(fixture.queries).toEqual([]);
  });

  it('maps the shared AIConfig resource into the UI policy', async () => {
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn()
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ocrModel: '/settings/providers/paddleocr.ttl#pp-ocrv6',
          embeddingModel: '/settings/providers/openai.ttl#text-embedding-3-small',
          ocrEnabled: false,
          automaticOcr: true,
          tableRecognition: true,
          processingMode: 'on-demand',
          updatedAt: new Date('2026-08-09T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ftsEnabled: true,
          vectorEnabled: true,
          progressiveIndexingEnabled: false,
          automaticIndexing: true,
          textBackend: 'fts5',
          vectorBackend: 'vec',
        }),
      updateById: vi.fn(),
      insert: vi.fn(),
    };
    const store = createStore(db);

    const policy = await store.read(owner);

    expect(db.findById).toHaveBeenCalledTimes(2);
    expect(policy).toMatchObject({
      models: {
        ocrModel: aiModelResource.buildIri(owner.podUrl, { id: 'paddleocr.ttl#pp-ocrv6' }),
        embeddingModel: aiModelResource.buildIri(owner.podUrl, { id: 'openai.ttl#text-embedding-3-small' }),
      },
      documentProcessing: {
        ocrEnabled: false,
        automaticOcr: true,
        tableRecognition: true,
        processingMode: 'on-demand',
      },
      searchIndexing: {
        ftsEnabled: true,
        vectorEnabled: true,
        progressiveIndexingEnabled: false,
        textBackend: 'fts5',
        vectorBackend: 'vec',
      },
      lifecycle: { automaticIndexing: true },
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
  });

  it('merges a partial update and writes shared resource columns', async () => {
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn()
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          embeddingModel: '/settings/providers/openai.ttl#old',
        })
        .mockResolvedValueOnce({
          id: 'config.ttl#config',
          ftsEnabled: true,
          vectorEnabled: false,
          progressiveIndexingEnabled: true,
          automaticIndexing: true,
          textBackend: 'auto',
          vectorBackend: 'auto',
        }),
      updateById: vi.fn(async () => ({})),
      insert: vi.fn(),
    };
    const store = createStore(db, () => new Date('2026-08-09T01:00:00.000Z'));

    const result = await store.update({
      ...owner,
      patch: {
        models: { embeddingModel: '/settings/providers/openai.ttl#new' },
        searchIndexing: { vectorEnabled: true, vectorBackend: 'vec' },
      },
    });

    expect(db.updateById).toHaveBeenCalledTimes(2);
    expect(db.updateById).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ name: 'aiConfig' }) }), 'config.ttl#config', expect.objectContaining({
      embeddingModel: aiModelResource.buildIri(owner.podUrl, { id: 'openai.ttl#new' }),
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
    }));
    expect(db.updateById).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ name: 'xpodAiConfig' }) }), 'config.ttl#config', expect.objectContaining({
      vectorEnabled: true,
      vectorBackend: 'vec',
    }));
    expect(result.models.embeddingModel).toContain('#new');
  });

  it('requires an owner Pod fetch instead of using request-supplied credentials', async () => {
    const getPodFetch = vi.fn(async () => undefined);
    const store = new DrizzlePodAiConfigStore({
      podAccess: { getPodFetch },
    });

    await expect(store.read(owner)).rejects.toThrow('service_access_missing');
    // The store asks for the owner's Pod interface fetch; without one it fails
    // rather than borrowing whatever credentials the request happened to carry.
    expect(getPodFetch).toHaveBeenCalledWith(owner.webId, { podBaseUrl: owner.podUrl });
  });

  it('forwards the authenticated Solid owner context and canonical Pod root to Pod interface access when reading', async () => {
    const getPodFetch = vi.fn(async () => globalThis.fetch);
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn().mockResolvedValue(null),
      updateById: vi.fn(),
      insert: vi.fn(),
    };
    const store = new DrizzlePodAiConfigStore({
      podAccess: { getPodFetch },
      dbFactory: vi.fn(async () => db),
    });

    await store.read({ ...cloudOwnerLocalPod, auth: cloudAuth });

    expect(getPodFetch).toHaveBeenCalledWith(
      cloudOwnerLocalPod.webId,
      { auth: cloudAuth, podBaseUrl: cloudOwnerLocalPod.podUrl },
    );
  });

  it('forwards the authenticated Solid owner context and canonical Pod root to Pod interface access when updating', async () => {
    const getPodFetch = vi.fn(async () => globalThis.fetch);
    const db = {
      init: vi.fn(async () => undefined),
      findById: vi.fn().mockResolvedValue(null),
      updateById: vi.fn(async () => null),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ execute: vi.fn(async () => undefined) })) })),
    };
    const store = new DrizzlePodAiConfigStore({
      podAccess: { getPodFetch },
      dbFactory: vi.fn(async () => db),
    });

    await store.update({
      ...cloudOwnerLocalPod,
      auth: cloudAuth,
      patch: { models: { chatModel: '/settings/providers/deepseek.ttl#chat' } },
    });

    expect(getPodFetch).toHaveBeenCalledWith(
      cloudOwnerLocalPod.webId,
      { auth: cloudAuth, podBaseUrl: cloudOwnerLocalPod.podUrl },
    );
  });
});

function createStore(db: any, now: () => Date = () => new Date()) {
  return new DrizzlePodAiConfigStore({
    podAccess: { getPodFetch: vi.fn(async () => globalThis.fetch) },
    dbFactory: vi.fn(async () => db),
    now,
  });
}

/** Real installed INSERT/UPDATE compilation and RDF column reads; only storage/transport is fake. */
function createRdfDatabase() {
  const orm = drizzle({ info: { isLoggedIn: true, webId: owner.webId }, fetch: async () => { throw new Error('no network in RDF regression'); } }, {
    podUrl: owner.podUrl, schema: { aiConfig: aiConfigResource, xpodAiConfig: xpodAiConfigResource }, autoConnect: false, resourcePreparation: 'off',
  });
  const graph = new Map<string, Triple[]>();
  const queries: string[] = [];
  const subject = (resource: AnyPodTable, id: string) => resource.buildIri(owner.podUrl, { id });
  const apply = (query: string) => {
    queries.push(query);
    const parsed = new SparqlParser().parse(query);
    if (parsed.type !== 'update') throw new Error('expected real ORM update');
    for (const operation of parsed.updates) {
      if ('delete' in operation) for (const pattern of operation.delete) for (const term of pattern.triples) {
        if (!('termType' in term.predicate)) throw new Error('expected RDF predicate');
        const predicate = term.predicate.value;
        const current = graph.get(term.subject.value) ?? [];
        graph.set(term.subject.value, current.filter(existing => !(existing.predicate.value === predicate &&
          (term.object.termType === 'Variable' || (existing.object.termType === term.object.termType && existing.object.value === term.object.value)))));
      }
      if ('insert' in operation) for (const pattern of operation.insert) for (const term of pattern.triples) {
        if (!('termType' in term.predicate)) throw new Error('expected RDF predicate');
        const predicate = term.predicate.value;
        const current = graph.get(term.subject.value) ?? [];
        if (!current.some(existing => existing.predicate.value === predicate && existing.object.termType === term.object.termType && existing.object.value === term.object.value)) current.push(term as Triple);
        graph.set(term.subject.value, current);
      }
    }
  };
  const read = (resource: AnyPodTable, id: string) => {
    const terms = graph.get(subject(resource, id));
    if (!terms) return null;
    const row: Record<string, unknown> = { id };
    for (const [name, column] of Object.entries(resource.columns as Record<string, PodColumn>)) {
      if (name === 'id') continue;
      const matches = terms.filter(term => term.predicate.value === column.getPredicate(resource.getNamespace()));
      if (matches.length) row[name] = handlerRegistry.getHandler(column).parseValue(matches[0]!.object, column);
    }
    return row;
  };
  return { queries, modelTerms: (key: keyof typeof aiConfigResource.columns) => (graph.get(subject(aiConfigResource, aiConfigResource.buildId({ id: 'config' }))) ?? [])
    .filter(term => term.predicate.value === aiConfigResource.columns[key].getPredicate(aiConfigResource.getNamespace()))
    .map(term => ({ termType: term.object.termType, value: term.object.value })), database: {
    init: vi.fn(),
    findById: vi.fn(async (resource: AnyPodTable, id: string) => read(resource, id)),
    insert: (resource: AnyPodTable) => ({ values: (row: Record<string, unknown>) => ({ execute: async () => { apply(orm.insert(resource).values(row).toSPARQL().query); } }) }),
    updateById: vi.fn(async (resource: AnyPodTable, id: string, row: Record<string, unknown>) => { apply(orm.session.update(resource).set(row).whereByIri(subject(resource, id)).toSPARQL().query); return read(resource, id); }),
  } };
}
