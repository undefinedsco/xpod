import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'n3';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { approvalResource, sessionResource, threadResource, type ApprovalInsert, type SessionInsert } from '@undefineds.co/models';
import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';

const pod = 'https://storage.example/alice/';
const owner = 'https://id.example/alice/profile/card#me';
const thread = 'task/work/index.ttl#thread';
const date = new Date('2026-10-04T00:00:00.000Z');
const session: SessionInsert = { id: '2026/10/04/run_one.ttl', owner, thread,
  tool: 'pi', status: 'active', createdAt: date, updatedAt: date };

function fixture(kind: 'session' | 'approval', storedThread?: string) {
  let body = ''; let version = 1; let writes = 0;
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (new Headers(init.headers).get('if-match') !== `"${version}"`) return new Response(null, { status: 412 });
      writes += 1; body = String(init.body); version += 1;
      return new Response(null, { status: 204 });
    }
    if (init?.method && init.method !== 'GET') {
      throw new Error(`Unexpected document mutation: ${init.method}`);
    }
    return new Response(body, { headers: { 'content-type': 'text/turtle', etag: `"${version}"` } });
  }) as typeof fetch;
  const db = drizzle({ fetch: request, info: { webId: owner, isLoggedIn: true } }, { podUrl: pod });
  const sessionIri = sessionResource.buildIriForDatabase(db, session);
  const threadIri = storedThread ?? threadResource.buildIriForDatabase(db, thread);
  const approval: ApprovalInsert = { id: '2026/10/04.ttl#approval_one', session: sessionIri, thread,
    toolCallId: 'call_one', toolName: 'write_file', target: `${pod}work/result.txt`,
    action: 'http://www.w3.org/ns/odrl/2/write', risk: 'high', status: 'pending', assignedTo: owner, createdAt: date };
  const resource = kind === 'session' ? sessionResource : approvalResource;
  const row = kind === 'session' ? session : approval;
  const iri = resource.buildIriForDatabase(db, row);
  body = `<${iri}> a <${resource.config.type}>.\n`;
  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    const predicate = resource.columns[key as keyof typeof resource.columns].options.predicate!;
    const term = key === 'thread' ? `<${threadIri}>`
      : ['owner', 'session', 'target', 'action', 'assignedTo'].includes(key) ? `<${value}>`
        : value instanceof Date ? `"${value.toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`
          : JSON.stringify(value);
    body += `<${iri}> <${predicate}> ${term}.\n`;
  }
  body += `<${iri}> <urn:untouched> "preserve this field".\n`;
  const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner },
    _cachedDb: db, _cachedFetch: request, _cachedPodBaseUrl: pod };
  return { db, store: new PodChatKitStore({}), context, approval, iri, threadIri,
    get writes() { return writes; },
    values(predicate: string) {
      return new Parser({ baseIRI: iri.split('#')[0] }).parse(body)
        .filter(quad => quad.subject.value === iri && quad.predicate.value === predicate).map(quad => quad.object.value);
    },
  };
}

describe('approval identity through the bound shared ORM', () => {
  it('updates a Session whose real RDF Thread relation reads as an absolute IRI', async () => {
    const f = fixture('session');
    expect((await f.db.findById(sessionResource, session.id!))?.thread).toBe(f.threadIri);
    const paused = { ...session, status: 'paused' as const };
    await expect(f.store.saveRunApprovalSession(paused, f.context)).resolves.toBe(f.iri);
    expect(paused.thread).toBe(thread);
    expect(f.values(sessionResource.columns.thread.options.predicate!)).toEqual([f.threadIri]);
    expect(f.values(sessionResource.columns.status.options.predicate!)).toEqual(['paused']);
    await f.store.saveRunApprovalSession({ ...session, status: 'completed' }, f.context);
    await f.store.saveRunApprovalSession(paused, f.context);
    expect(f.values(sessionResource.columns.status.options.predicate!)).toEqual(['completed']);
    expect(f.values('urn:untouched')).toEqual(['preserve this field']);
    expect(f.writes).toBe(2);
  });

  it.each([
    { owner: owner.replace('#me', '#other') },
    { owner: owner.replace('#me', '') },
    { owner: 'https://id.example/bob/profile/card#me' },
    { thread: thread.replace('#thread', '#other') },
    { thread: 'https://foreign.example/alice/.data/task/work/index.ttl#thread' },
  ])('rejects a different Session owner or Thread (%j)', async change => {
    const f = fixture('session');
    await expect(f.store.saveRunApprovalSession({ ...session, ...change, status: 'paused' }, f.context))
      .rejects.toThrow('Approval session identity mismatch');
    expect(f.writes).toBe(0);
  });

  it('recognizes an existing checkpoint after real RDF relation deserialization', async () => {
    const f = fixture('approval');
    expect((await f.db.findById(approvalResource, f.approval.id!))?.thread).toBe(f.threadIri);
    await expect(f.store.writeTaskApproval(f.approval, f.context)).resolves.toBe(f.iri);
    expect(f.approval.thread).toBe(thread);
    expect(f.writes).toBe(0);
  });

  it('returns the shared Thread ID to the business layer when reading a checkpoint', async () => {
    const f = fixture('approval');
    await expect(f.store.readTaskApproval(f.iri, f.context)).resolves.toMatchObject({
      thread, assignedTo: owner, session: f.approval.session,
    });
  });

  it.each([
    'https://foreign.example/alice/.data/task/work/index.ttl#thread',
    'https://storage.example/alice/.data/task/work/index.ttl#other',
  ])('preserves a different checkpoint Thread for business authorization (%s)', async storedThread => {
    const f = fixture('approval', storedThread);
    const row = await f.store.readTaskApproval(f.iri, f.context);
    expect(row?.thread).not.toBe(thread);
    if (storedThread.startsWith('https://foreign.example/')) expect(row?.thread).toBe(storedThread);
    expect(row?.assignedTo).toBe(owner);
    expect(f.writes).toBe(0);
  });

  it.each([
    { assignedTo: owner.replace('#me', '#other') },
    { assignedTo: owner.replace('#me', '') },
    { assignedTo: 'https://id.example/bob/profile/card#me' },
    { thread: thread.replace('#thread', '#other') },
    { thread: 'https://foreign.example/alice/.data/task/work/index.ttl#thread' },
    { toolCallId: 'call_other' },
    { session: 'https://foreign.example/alice/.data/sessions/2026/10/04/run_one.ttl' },
    { target: `${pod}work/other.txt` },
    { action: 'http://www.w3.org/ns/odrl/2/read' },
  ])('rejects a checkpoint identity change (%j)', async change => {
    const f = fixture('approval');
    await expect(f.store.writeTaskApproval({ ...f.approval, ...change }, f.context))
      .rejects.toThrow('Approval checkpoint identity mismatch');
    expect(f.writes).toBe(0);
  });

  it('rejects a checkpoint target outside the bound Pod before writing', async () => {
    const f = fixture('approval');
    await expect(f.store.writeTaskApproval({ ...f.approval, target: 'https://foreign.example/alice/work/result.txt' }, f.context))
      .rejects.toThrow('Approval target must belong to the current Pod');
    expect(f.writes).toBe(0);
  });
});
