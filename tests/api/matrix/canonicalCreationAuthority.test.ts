import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Parser as SparqlParser } from 'sparqljs';
import { DataFactory, Writer, type Quad } from 'n3';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource } from '@undefineds.co/models';
import { CanonicalRoomSource } from '../../../src/api/matrix/canonicalRoomSource';
import {
  canonicalChatResourceId,
  decodeSourceBoundRoomId,
  encodeSourceBoundRoomId,
} from '../../../src/api/matrix/canonicalRoomIdentity';
import {
  closeAllIdentityConnections,
  executeStatement,
  getIdentityDatabase,
} from '../../../src/identity/drizzle/db';
import { PodLookupRepository } from '../../../src/identity/drizzle/PodLookupRepository';

afterAll(async() => { await closeAllIdentityConnections(); });

const ALICE = 'https://alice.example/profile/card#me';
const BOB = 'https://bob.example/profile/card#me';
const ALICE_POD = 'https://alice.example/alice/';
const BOB_POD = 'https://bob.example/bob/';

async function database() {
  const db = getIdentityDatabase(`sqlite::memory:canonical-create-${crypto.randomUUID()}`);
  await executeStatement(db, sql`CREATE TABLE internal_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`);
  await executeStatement(db, sql`CREATE TABLE identity_store (container TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(container,id))`);
  return db;
}

/** A genuine registry: one canonical Pod record per owner WebID, with the owner binding explicit. */
async function registry(owners: ReadonlyArray<{ podId: string; webId: string; baseUrl: string }>): Promise<PodLookupRepository> {
  const db = await database();
  for (const owner of owners) {
    await executeStatement(db, sql`INSERT INTO identity_store VALUES ('pod',${owner.podId},${JSON.stringify({ accountId: owner.podId, baseUrl: owner.baseUrl, webId: owner.webId })})`);
    await executeStatement(db, sql`INSERT INTO identity_store VALUES ('owner',${`owner-${owner.podId}`},${JSON.stringify({ podId: owner.podId, webId: owner.webId })})`);
  }
  return new PodLookupRepository(db);
}

function context(webId: string, podUrl: string, overrides: Record<string, unknown> = {}) {
  return { webId, podUrl, auth: { type: 'solid', webId }, ...overrides } as never;
}

/** A port whose caller fetch must never be called during creation qualification. */
function port(pods: PodLookupRepository, onFetch?: () => void): CanonicalRoomSource {
  return new CanonicalRoomSource({
    pods,
    callerFetchFor: async() => { onFetch?.(); throw new Error('Creation qualification must not fetch'); },
  });
}

describe('canonical creation ownership qualification', () => {
  it('accepts the exact registered owner of the chosen Pod and returns its root', async() => {
    const pods = await registry([{ podId: 'pod-alice', webId: ALICE, baseUrl: ALICE_POD }]);
    const source = chatResource.buildIri(ALICE_POD, { id: 'new-room' });
    let fetched = false;
    const result = await port(pods, () => { fetched = true; }).assertCreationOwner(source, context(ALICE, ALICE_POD));
    expect(result).toEqual({ sourceRoot: ALICE_POD });
    expect(fetched).toBe(false);
  });

  it('refuses a caller whose session does not match the context before any lookup', async() => {
    const pods = await registry([{ podId: 'pod-alice', webId: ALICE, baseUrl: ALICE_POD }]);
    const source = chatResource.buildIri(ALICE_POD, { id: 'new-room' });
    await expect(port(pods).assertCreationOwner(source, context(BOB, ALICE_POD, { auth: { type: 'solid', webId: ALICE } })))
      .rejects.toMatchObject({ status: 403 });
    await expect(port(pods).assertCreationOwner(source, context(BOB, ALICE_POD, { service: { taskCredential: {} } })))
      .rejects.toMatchObject({ status: 403 });
    await expect(port(pods).assertCreationOwner(source, context(BOB, ALICE_POD, { auth: { type: 'service' } })))
      .rejects.toMatchObject({ status: 403 });
  });

  it('refuses an unknown Pod and a different full WebID on the same host', async() => {
    const pods = await registry([{ podId: 'pod-bob', webId: BOB, baseUrl: BOB_POD }]);
    const source = chatResource.buildIri(ALICE_POD, { id: 'new-room' });
    await expect(port(pods).assertCreationOwner(source, context(ALICE, ALICE_POD)))
      .rejects.toMatchObject({ status: 403 });
    // The same host but a different registered owner is not ownership.
    const sameHost = await registry([{ podId: 'pod-other', webId: 'https://alice.example/other#me', baseUrl: ALICE_POD }]);
    await expect(port(sameHost).assertCreationOwner(source, context(ALICE, ALICE_POD)))
      .rejects.toMatchObject({ status: 403 });
  });

  it('refuses a source whose fragment/owner is not the exact canonical Chat of the scope', async() => {
    const pods = await registry([{ podId: 'pod-alice', webId: ALICE, baseUrl: ALICE_POD }]);
    for (const bad of [
      `${ALICE_POD}.data/chat/x/index.ttl#other`,
      `${ALICE_POD}.data/chat/x/index.ttl`,
      `${ALICE_POD}not-a-chat#this`,
    ]) {
      await expect(port(pods).assertCreationOwner(bad, context(ALICE, ALICE_POD)), bad)
        .rejects.toMatchObject({ status: 403 });
    }
  });

  it('refuses a source whose registered root is owned by a different full WebID', async() => {
    const pods = await registry([
      { podId: 'pod-alice', webId: ALICE, baseUrl: ALICE_POD },
      { podId: 'pod-bob-child', webId: BOB, baseUrl: `${ALICE_POD}child/` },
    ]);
    const source = chatResource.buildIri(`${ALICE_POD}child/`, { id: 'new-room' });
    // Alice claims a Pod registered to Bob; ownership fails even though the layout is canonical.
    await expect(port(pods).assertCreationOwner(source, context(ALICE, `${ALICE_POD}child/`)))
      .rejects.toMatchObject({ status: 403 });
    // Bob, the actual registered owner, is accepted.
    const accepted = await port(pods).assertCreationOwner(source, context(BOB, `${ALICE_POD}child/`));
    expect(accepted.sourceRoot).toBe(`${ALICE_POD}child/`);
  });
});

describe('canonical exact resource id', () => {
  it('addresses an original source whose key contains a percent escape, unlike the public buildId', () => {
    const source = chatResource.buildIri(ALICE_POD, { id: 'a%2Fb' });
    const exact = canonicalChatResourceId(source, ALICE_POD);
    expect(exact).not.toBeNull();
    // The public id decodes the escape; the exact id must reproduce the original source exactly.
    expect(chatResource.buildIri(ALICE_POD, { id: exact! })).toBe(source);
  });

  it('returns null for a wrong root, a foreign source, or a non-Chat IRI', () => {
    const source = chatResource.buildIri(ALICE_POD, { id: 'a%2Fb' });
    expect(canonicalChatResourceId(source, BOB_POD)).toBeNull();
    expect(canonicalChatResourceId(`${ALICE_POD}not-a-chat#this`, ALICE_POD)).toBeNull();
  });
});

describe('a created source is readable back through the canonical port', () => {
  it('reads the exact created source, root roles and participants through a real ORM document', async() => {
    const pods = await registry([{ podId: 'pod-alice', webId: ALICE, baseUrl: ALICE_POD }]);
    const source = chatResource.buildIri(ALICE_POD, { id: 'room-x' });
    const roomId = encodeSourceBoundRoomId(source);
    const chatId = canonicalChatResourceId(source, ALICE_POD)!;
    // Build the Chat row for the new room through the real public ORM.
    const turtle = await ormTurtle({
      id: chatId,
      title: 'room',
      author: ALICE,
      participants: [ ALICE ],
      createdAt: '2026-10-03T00:00:00.000Z',
      metadata: { memberRoles: { [ALICE]: 'owner' }, protocols: { matrix: { roomId } } },
    });
    expect(decodeSourceBoundRoomId(roomId)).toMatchObject({ status: 'source-bound', canonicalChatIri: source });

    const readPort = new CanonicalRoomSource({
      pods,
      callerFetchFor: async() => async() => {
        const response = new Response(turtle, { headers: { 'content-type': 'text/turtle' } });
        Object.defineProperty(response, 'url', { value: source.split('#')[0] });
        return response;
      },
    });
    const facts = await readPort.read(roomId, context(ALICE, ALICE_POD));
    expect(facts).toMatchObject({
      sourceIri: source,
      authorWebId: ALICE,
      participants: [ ALICE ],
      memberRoles: { [ALICE]: 'owner' },
    });
  });
});

async function ormTurtle(row: Record<string, unknown>): Promise<string> {
  const session = drizzle(
    { fetch: async() => new Response(null, { status: 204 }), info: { webId: ALICE, isLoggedIn: true, podUrl: ALICE_POD } },
    { podUrl: ALICE_POD, schema: { chat: chatResource }, resourcePreparation: 'off' },
  );
  const query = (session.insert(chatResource).values(row as never) as never as { toSPARQL: () => { query: string } }).toSPARQL().query;
  const parsed = new SparqlParser().parse(query) as any;
  const collect = (patterns: any[]): any[] => patterns.flatMap(p => p.type === 'bgp'
    ? p.triples
    : p.type === 'graph' ? collect(p.patterns ?? [{ type: 'bgp', triples: p.triples ?? [] }]) : []);
  const quads: Quad[] = parsed.updates.flatMap((u: any) => collect(u.insert ?? []))
    .map((t: any) => DataFactory.quad(t.subject, t.predicate, t.object));
  const writer = new Writer();
  writer.addQuads(quads);
  return await new Promise<string>((resolve, reject) => writer.end((error, text) => error ? reject(error) : resolve(text)));
}
