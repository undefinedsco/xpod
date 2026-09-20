import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import {
  LiveAuthError,
  LiveUnsupportedError,
  applyLivePlan,
  createLivePodStore,
  describeLiveWrites,
  documentsFromLiveRows,
  guardScan,
  liveDocumentId,
  loadLiveDocuments,
  loadPodDocuments,
  planMigration,
  parseOptions,
  planLiveWrites,
  readBackEvidence,
  resolveLiveSession,
  type Document,
  type LiveLinkPatch,
  type LivePodStore,
  type LiveRows,
  type LiveSession,
  type LiveWritePlan,
} from './migrate-ai-offering-storage';

const POD_URL = 'https://pod.example/glocal/';
const PROVIDER_IRI = `${POD_URL}settings/providers/openai.ttl`;
const LEGACY_PROVIDER_IRI = `${POD_URL}settings/providers/openai-official-subscription.ttl`;
const CREDENTIAL_IRI = `${POD_URL}settings/credentials.ttl#local-openai-c9e26cb4-76ea-46d8-9f0e-dabc5180c89c`;
const HAS_MODEL = 'https://undefineds.co/ns#hasModel';

const MODEL_KEYS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'];
const REAL_REFS = MODEL_KEYS.map((key) => `${PROVIDER_IRI}#${key}`);
const PHANTOM_REFS = MODEL_KEYS.map((key) => `${LEGACY_PROVIDER_IRI}#${key}`);

const created: string[] = [];
const fixtureBase = path.resolve('.test-data/migrate-ai-offering-live');
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});
afterAll(() => rmSync(fixtureBase, { recursive: true, force: true }));

/** The live Pod the parent's dry run reported: one credential, six hasModel, three of them phantom. */
function providerDocument(): string {
  const lines: string[] = [];
  for (const key of MODEL_KEYS) {
    const subject = `${PROVIDER_IRI}#${key}`;
    lines.push(
      `<${subject}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://undefineds.co/ns#AIModel> .`,
      `<${subject}> <https://undefineds.co/ns#createdAt> "2026-09-14T04:30:15.698Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
      `<${subject}> <https://undefineds.co/ns#displayName> "${key}" .`,
      `<${subject}> <https://undefineds.co/ns#isProvidedBy> <${PROVIDER_IRI}> .`,
      `<${subject}> <https://undefineds.co/ns#status> "active" .`,
      `<${subject}> <https://undefineds.co/ns#updatedAt> "2026-09-14T04:30:15.698Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    );
  }
  lines.push(
    `<${PROVIDER_IRI}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://undefineds.co/ns#Provider> .`,
    `<${PROVIDER_IRI}> <https://undefineds.co/ns#displayName> "OpenAI" .`,
  );
  for (const reference of [...PHANTOM_REFS, ...REAL_REFS]) {
    lines.push(`<${PROVIDER_IRI}> <${HAS_MODEL}> <${reference}> .`);
  }
  return `${lines.join('\n')}\n`;
}

function credentialsDocument(offeringId?: string): string {
  const lines = [
    `<${CREDENTIAL_IRI}> <http://purl.org/dc/terms/created> "2026-09-14T04:30:10.074Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    `<${CREDENTIAL_IRI}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://undefineds.co/ns#Credential> .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#accountLabel> "OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#authMode> "deviceCodeOAuth" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#label> "OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#provider> <${PROVIDER_IRI}> .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#keyVersion> "2" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#service> "ai" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#status> "active" .`,
    `<${CREDENTIAL_IRI}> <https://undefineds.co/ns#metadata> "{\\"health\\":\\"healthy\\"}"^^<http://www.w3.org/2001/XMLSchema#json> .`,
  ];
  if (offeringId) {
    lines.push(`<${CREDENTIAL_IRI}> <https://undefineds.co/ns#offeringId> "${offeringId}" .`);
  }
  return `${lines.join('\n')}\n`;
}

/** The same Pod as drizzle-solid `select()` returns it: absolute subjects, arrays for links. */
function liveRows(options: { phantom?: boolean; legacyDocument?: boolean; offeringId?: string } = {}): LiveRows {
  const rows: LiveRows = {
    credentials: [{
      '@id': CREDENTIAL_IRI,
      provider: PROVIDER_IRI,
      authMode: 'deviceCodeOAuth',
      accountLabel: 'OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a',
      label: 'OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a',
      service: 'ai',
      status: 'active',
      keyVersion: '2',
      metadata: '{"health":"healthy"}',
      ...(options.offeringId ? { offeringId: options.offeringId } : {}),
    }],
    providers: [{
      '@id': PROVIDER_IRI,
      displayName: 'OpenAI',
      hasModel: options.phantom === false ? REAL_REFS : [...PHANTOM_REFS, ...REAL_REFS],
    }],
    models: MODEL_KEYS.map((key) => {
      const document = options.legacyDocument ? LEGACY_PROVIDER_IRI : PROVIDER_IRI;
      return {
        '@id': `${document}#${key}`,
        displayName: key,
        isProvidedBy: document,
        status: 'active',
        createdAt: '2026-09-14T04:30:15.698Z',
        updatedAt: '2026-09-14T04:30:15.698Z',
      };
    }),
  };
  if (options.legacyDocument) {
    // The model rows live in the legacy offering document, which therefore exists.
    rows.providers[0]!.hasModel = [...PHANTOM_REFS];
  }
  return rows;
}

function offlinePodRoot(options: { offeringId?: string } = {}): string {
  const base = fixtureBase;
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'pod-'));
  created.push(root);
  mkdirSync(path.join(root, 'settings/providers'), { recursive: true });
  writeFileSync(path.join(root, 'settings/credentials.ttl'), credentialsDocument(options.offeringId));
  writeFileSync(path.join(root, 'settings/providers/openai.ttl'), providerDocument());
  return root;
}

/** A stand-in for the live store that applies PATCHes the way the real Pod does. */
class FakeLiveStore implements LivePodStore {
  readonly podUrl = POD_URL;
  readonly endpoint = `${POD_URL}settings/-/sparql`;
  readonly session: LiveSession = { fetch: async () => new Response('{}'), webId: 'webId', source: 'test' };
  readonly credentialCalls: { credentialId: string; patch: Record<string, unknown> }[] = [];
  readonly patches: LiveLinkPatch[] = [];

  constructor(private rows: LiveRows) {}

  async selectCredentials(): Promise<Record<string, unknown>[]> {
    return this.rows.credentials.map((row) => ({ ...row }));
  }

  async selectProviders(): Promise<Record<string, unknown>[]> {
    return this.rows.providers.map((row) => ({ ...row }));
  }

  async selectModels(): Promise<Record<string, unknown>[]> {
    return this.rows.models.map((row) => ({ ...row }));
  }

  async updateCredential(credentialId: string, patch: Record<string, unknown>): Promise<void> {
    this.credentialCalls.push({ credentialId, patch });
    this.rows.credentials = this.rows.credentials.map((row, index) => (index === 0 ? { ...row, ...patch } : row));
  }

  renderProviderModelUpdate(_providerId: string, modelIds: readonly string[]): string | undefined {
    return `INSERT DATA { GRAPH <${PROVIDER_IRI}> { <${PROVIDER_IRI}> <${HAS_MODEL}> "${modelIds.map((id) => `\\"${id}\\"`).join(',')}". } }`;
  }

  async patchLinks(patch: LiveLinkPatch): Promise<void> {
    this.patches.push({ ...patch });
    this.rows.providers = this.rows.providers.map((row) => {
      if (liveRowIri(row) !== patch.subject) return row;
      const current = Array.isArray(row.hasModel) ? row.hasModel as string[] : [];
      // RDF is a set: INSERT DATA of a triple that is already there changes nothing.
      return {
        ...row,
        hasModel: [...new Set([...current.filter((reference) => !patch.remove.includes(reference)), ...patch.add])],
      };
    });
  }
}

function liveRowIri(row: Record<string, unknown>): string {
  return String(row['@id'] ?? '');
}

async function livePlan(rows: LiveRows): Promise<LiveWritePlan> {
  const documents = documentsFromLiveRows(POD_URL, rows);
  const plan = planMigration(documents);
  return planLiveWrites(POD_URL, plan, documents);
}

/** Plan a document set the way the script does: scan before, plan, scan after. */
function planFixture(documents: Map<string, Document>) {
  const original = new Map([...documents].map(([id, document]) => [
    id,
    { ...document, quads: [...document.quads], originalQuads: [...document.originalQuads] },
  ]));
  const found = guardScan(original);
  const plan = planMigration(documents);
  return { plan, found, after: guardScan(documents) };
}

describe('live mode discovers what the offline mode discovers', () => {
  test('the same Pod yields the same plan and guard scan in both modes', async () => {
    const root = offlinePodRoot();
    const offlineResult = await planFixture(await loadPodDocuments(root));
    const liveResult = await planFixture(documentsFromLiveRows(POD_URL, liveRows()));

    expect(liveResult.plan).toEqual(offlineResult.plan);
    expect(liveResult.found).toEqual(offlineResult.found);
    expect(liveResult.after).toEqual(offlineResult.after);
    expect(offlineResult.found).toHaveLength(3);
    expect(offlineResult.after).toHaveLength(0);
    expect(offlineResult.plan.credentialFindings).toEqual([{
      subject: CREDENTIAL_IRI,
      provider: 'openai',
      offeringId: 'official-subscription',
      evidence: 'account label "OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a"',
    }]);
  });

  test('a row id is absolutized so live subjects match file subjects', () => {
    const documents = documentsFromLiveRows(POD_URL, {
      credentials: [{ id: 'credentials.ttl#local-openai-c9e26cb4-76ea-46d8-9f0e-dabc5180c89c', provider: 'openai.ttl', authMode: 'local' }],
      providers: [],
      models: [],
    });
    expect([...documents.keys()]).toEqual(['settings/credentials.ttl']);
    expect([...new Set(documents.get('settings/credentials.ttl')!.quads
      .map((quad) => quad.subject.value))]).toEqual([CREDENTIAL_IRI]);
  });
});

describe('live writes', () => {
  test('the plan names the drizzle-solid call and the hasModel PATCH', async () => {
    const writePlan = await livePlan(liveRows());
    expect(writePlan.unsupported).toEqual([]);
    expect(writePlan.credentialWrites).toEqual([{
      subject: CREDENTIAL_IRI,
      credentialId: 'credentials.ttl#local-openai-c9e26cb4-76ea-46d8-9f0e-dabc5180c89c',
      patch: { offeringId: 'official-subscription' },
      reason: 'offeringId=official-subscription [openai: account label "OpenAI Subscription d6649e3a-59b2-4aa8-ac81-88624235e96a"]',
    }]);
    expect(writePlan.linkPatches).toEqual([{
      subject: PROVIDER_IRI,
      predicate: HAS_MODEL,
      documentUrl: PROVIDER_IRI,
      remove: [...PHANTOM_REFS].sort(),
      add: [...REAL_REFS].sort(),
    }]);
  });

  test('applying issues both writes and the read-back is clean', async () => {
    const store = new FakeLiveStore(liveRows());
    const writePlan = await livePlan(liveRows());
    const applied = await applyLivePlan(store, writePlan);

    expect(store.credentialCalls).toEqual([{
      credentialId: 'credentials.ttl#local-openai-c9e26cb4-76ea-46d8-9f0e-dabc5180c89c',
      patch: { offeringId: 'official-subscription' },
    }]);
    expect(store.patches).toEqual(writePlan.linkPatches);
    expect(applied).toHaveLength(2);

    const evidence = await readBackEvidence(store, writePlan);
    expect(evidence.problems).toEqual([]);
    const text = evidence.lines.join('\n');
    for (const reference of PHANTOM_REFS) expect(text).not.toContain(reference);
    for (const reference of REAL_REFS) {
      expect(text).toContain(`ok ${path.basename(reference)}  present exactly once: true`);
    }
    expect(text).toContain('udfs:offeringId = "official-subscription"');
    expect(text).toContain(`guard scan through ${store.endpoint}: 0 unresolved`);
  });

  test('a re-run after apply finds nothing to do', async () => {
    const store = new FakeLiveStore(liveRows());
    await applyLivePlan(store, await livePlan(liveRows()));
    const second = await livePlan({
      credentials: await store.selectCredentials(),
      providers: await store.selectProviders(),
      models: await store.selectModels(),
    });
    expect(second.credentialWrites).toEqual([]);
    expect(second.linkPatches).toEqual([]);
    expect(second.unsupported).toEqual([]);
  });

  test('the read-back reports a store that did not keep the correction', async () => {
    const rows = liveRows();
    const writePlan = await livePlan(rows);
    // A store that acknowledges the credential update but persists nothing.
    const store = new FakeLiveStore(rows);
    store.updateCredential = async () => undefined;
    store.patchLinks = async () => undefined;
    const evidence = await readBackEvidence(store, writePlan);
    expect(evidence.problems.length).toBeGreaterThan(0);
    expect(evidence.lines.join('\n')).not.toContain(`guard scan through ${store.endpoint}: 0 unresolved`);
  });

  test('folding a legacy offering document is refused, not half-applied', async () => {
    const store = new FakeLiveStore(liveRows({ legacyDocument: true }));
    const writePlan = await livePlan(liveRows({ legacyDocument: true }));
    expect(writePlan.unsupported.join('\n')).toContain('live mode does not implement document folding');
    await expect(applyLivePlan(store, writePlan)).rejects.toBeInstanceOf(LiveUnsupportedError);
    expect(store.credentialCalls).toEqual([]);
    expect(store.patches).toEqual([]);
  });

  test('the dry run prints the call, the PATCH and the rendering it avoids', async () => {
    const store = new FakeLiveStore(liveRows());
    const lines = describeLiveWrites(store, await livePlan(liveRows())).join('\n');
    expect(lines).toContain('db.updateById(credentialResource, "credentials.ttl#local-openai-c9e26cb4-76ea-46d8-9f0e-dabc5180c89c", { offeringId: "official-subscription" })');
    expect(lines).toContain(`PATCH ${PROVIDER_IRI}  (content-type: application/sparql-update)`);
    expect(lines).toContain('DELETE DATA');
    expect(lines).toContain('INSERT DATA');
    expect(lines).toContain('drizzle-solid cannot state this predicate correctly');
  });
});

describe('live session resolution', () => {
  test('without either documented source it fails loudly and points at the login command', async () => {
    await expect(resolveLiveSession(POD_URL, {
      env: {},
      stored: null,
      storedPath: '/tmp/does-not-exist/credentials.json',
    })).rejects.toBeInstanceOf(LiveAuthError);
    const error = await resolveLiveSession(POD_URL, {
      env: {},
      stored: null,
      storedPath: '/tmp/does-not-exist/credentials.json',
    }).catch((reason: unknown) => reason as Error);
    expect(error.message).toContain('refuses to fall back to files');
    expect(error.message).toContain('bun src/cli/index.ts auth login --url https://pod.example/');
    expect(error.message).toContain('SOLID_CLIENT_ID / SOLID_CLIENT_SECRET');
    expect(error.message).toContain('/tmp/does-not-exist/credentials.json does not exist');
  });
});

describe('the drizzle-solid gap this migration works around', () => {
  test('its array update renders one literal, so the PATCH is the only correct write', () => {
    const session: SolidAuthSession = {
      info: { webId: `${POD_URL}profile/card#me`, isLoggedIn: true },
      fetch: async () => { throw new Error('rendering must not reach the network'); },
    } as SolidAuthSession;
    credentialResource.setSparqlEndpoint(`${POD_URL}settings/-/sparql`);
    const database = drizzle(session, {
      podUrl: POD_URL,
      schema: { aiModel: aiModelResource, aiProvider: aiProviderResource, credential: credentialResource },
      autoConnect: false,
      resourcePreparation: 'off',
    });
    const rendered = database.session
      .update(aiProviderResource)
      .set({ hasModel: REAL_REFS } as never)
      .whereByIri(PROVIDER_IRI)
      .toSPARQL().query;
    expect(rendered).toContain('DELETE');
    expect(rendered).toContain('?old_hasModel_0');
    expect(rendered).toMatch(/hasModel> "\\"/u);
    for (const reference of REAL_REFS) expect(rendered).not.toContain(`<${reference}>`);
  });

  test('the store renders that statement for the report', async () => {
    credentialResource.setSparqlEndpoint(`${POD_URL}settings/-/sparql`);
    const store = await createLivePodStore(POD_URL, {
      fetch: async () => new Response('{}'),
      webId: `${POD_URL}profile/card#me`,
      source: 'test',
    });
    const rendered = store.renderProviderModelUpdate('openai.ttl', REAL_REFS);
    expect(rendered).toContain('?old_hasModel_0');
    expect(rendered).toMatch(/hasModel> "\\"/u);
  });
});

describe('loading live documents', () => {
  test('a rejected read names the session and the endpoint', async () => {
    const store = new FakeLiveStore(liveRows());
    store.selectCredentials = async () => { throw new Error('Unexpected response status 401'); };
    await expect(loadLiveDocuments(store)).rejects.toThrow(/rejected the session.*HTTP 401/su);
  });
});

describe('argument parsing', () => {
  test('--pod and --live are mutually exclusive', () => {
    expect(() => parseOptions(['--pod', '/tmp/pod', '--live', POD_URL])).toThrow(/mutually exclusive/u);
  });

  test('--backup-dir is offline-only', () => {
    expect(() => parseOptions(['--live', POD_URL, '--backup-dir', '/tmp/backup'])).toThrow(/offline-only/u);
  });

  test('live mode accepts the documented flags', () => {
    expect(parseOptions(['--live', POD_URL, '--apply'])).toMatchObject({
      live: POD_URL,
      podRoot: '',
      apply: true,
      verify: false,
    });
  });
});

describe('fixture helpers', () => {
  test('a live subject maps back to its Pod-relative document id', () => {
    expect(liveDocumentId(POD_URL, `${POD_URL}settings/providers/openai.ttl`)).toBe('settings/providers/openai.ttl');
  });
});
