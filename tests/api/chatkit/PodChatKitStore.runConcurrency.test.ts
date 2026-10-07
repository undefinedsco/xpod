import { describe, expect, it, vi } from 'vitest';
import { Parser } from 'n3';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { sessionResource } from '@undefineds.co/models';
import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { ClientToolContinuationClaim, StoreContext } from '../../../src/api/chatkit/store';
import { Run } from '../../../src/api/runs/schema';
import type { RunRecordData } from '../../../src/api/runs/store';

const pod = 'https://pod.test/alice/';
const owner = `${pod}profile/card#me`;
const runId = 'task/work/2026/10/01/runs.ttl#one';
const iri = `${pod}.data/${runId}`;
const documentUrl = iri.split('#')[0];
const statusPredicate = Run.columns.status.options.predicate!;
const cancelPredicate = Run.columns.cancelRequestedAt.options.predicate!;
const timePredicate = Run.columns.updatedAt.options.predicate!;
const run = (status: RunRecordData['status'] = 'running'): RunRecordData => ({
  id: runId, thread: `${pod}.data/task/work/index.ttl#thread`, workspace: `${pod}work/`, runner: 'pi:pi',
  status, createdAt: 1, updatedAt: 1, metadata: { label: 'fresh' },
});
const seed = (status = 'running') => `
<${iri}> a <${Run.config.type}>; <${statusPredicate}> "${status}"; <${timePredicate}> "1970-01-01T00:00:01.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>;
  <urn:untouched> "preserve this field".
<${documentUrl}#two> a <${Run.config.type}>; <${statusPredicate}> "queued".
<${documentUrl}#step> <urn:message> "preserve this step".
`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function documentServer(initial: string) {
  let body = initial; let version = 1; let puts = 0; let conflicts = 0;
  let validator: string | undefined;
  const reached = deferred(); const release = deferred();
  const makeFetch = (pauseFirstRead = false): typeof fetch => {
    let first = true;
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts += 1;
        if (new Headers(init.headers).get('if-match') !== `"${version}"`) {
          conflicts += 1; return new Response('', { status: 412 });
        }
        body = String(init.body); version += 1;
        return new Response(null, { status: 204 });
      }
      const snapshot = body; const etag = validator ?? `"${version}"`;
      if (first && pauseFirstRead) { first = false; reached.resolve(); await release.promise; }
      return new Response(snapshot, { headers: { 'content-type': 'text/turtle', etag } });
    }) as typeof fetch;
  };
  return { makeFetch, reached, release,
    values(subject: string, predicate: string) {
      return new Parser({ baseIRI: documentUrl }).parse(body)
        .filter(quad => quad.subject.value === subject && quad.predicate.value === predicate).map(quad => quad.object.value);
    },
    setValidator(value: string) { validator = value; },
    get puts() { return puts; }, get conflicts() { return conflicts; },
  };
}

function client(authenticatedFetch: typeof fetch, existing: object = run()) {
  const db = drizzle({ fetch: authenticatedFetch, info: { webId: owner, isLoggedIn: true } } as never,
    { schema: { run: Run, session: sessionResource } });
  vi.spyOn(db, 'findById').mockResolvedValue(existing as never);
  const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner },
    _cachedDb: db, _cachedFetch: authenticatedFetch, _cachedPodBaseUrl: pod };
  return { store: new PodChatKitStore({}), context };
}

describe('Pod Run document cancellation compare-and-swap', () => {
  it.each(['running', 'failed', 'completed', 'waiting_input'] as const)('rebases a stale %s write after another client cancels', async status => {
    const server = documentServer(seed(status === 'running' ? 'queued' : 'running'));
    const first = client(server.makeFetch(true)); const second = client(server.makeFetch());
    const stale = { ...run(), status, error: 'obsolete failure' };
    const pending = first.store.saveRun(stale, first.context);
    await server.reached.promise;
    const cancelled = { ...run(), status: 'cancelled' as const, cancelRequestedAt: 123, completedAt: 123 };
    await second.store.saveRun(cancelled, second.context);
    server.release.resolve(); await pending;
    expect(server.conflicts).toBe(1);
    expect(server.values(iri, statusPredicate)).toEqual(['cancelled']);
    expect(server.values(iri, cancelPredicate)).toEqual(['1970-01-01T00:02:03.000Z']);
    expect(server.values(iri, Run.columns.error.options.predicate!)).toEqual([]);
    expect(stale).toMatchObject({ status: 'cancelled', cancelRequestedAt: 123 });
    expect(stale.error).toBeUndefined();
    expect(server.values(`${documentUrl}#two`, statusPredicate)).toEqual(['queued']);
    expect(server.values(`${documentUrl}#step`, 'urn:message')).toEqual(['preserve this step']);
    expect(server.values(iri, 'urn:untouched')).toEqual(['preserve this field']);
  });

  it('keeps a running Stop request monotonic until the finisher records cancellation', async () => {
    const server = documentServer(seed());
    const first = client(server.makeFetch(true)); const second = client(server.makeFetch());
    const pending = first.store.saveRun({ ...run(), status: 'failed' }, first.context);
    await server.reached.promise;
    await second.store.saveRun({ ...run(), cancelRequestedAt: 123 }, second.context);
    expect(server.values(iri, statusPredicate)).toEqual(['running']);
    server.release.resolve(); await pending;
    expect(server.values(iri, statusPredicate)).toEqual(['cancelled']);
    expect(server.values(iri, cancelPredicate)).toEqual(['1970-01-01T00:02:03.000Z']);
  });

  it('preserves another Run committed to the same document while retrying', async () => {
    const server = documentServer(seed());
    const first = client(server.makeFetch(true)); const second = client(server.makeFetch());
    const pending = first.store.saveRun({ ...run(), status: 'completed' }, first.context);
    await server.reached.promise;
    await second.store.saveRun({ ...run(), id: runId.replace('#one', '#two'), status: 'failed' }, second.context);
    server.release.resolve(); await pending;
    expect(server.conflicts).toBe(1);
    expect(server.values(iri, statusPredicate)).toEqual(['completed']);
    expect(server.values(`${documentUrl}#two`, statusPredicate)).toEqual(['failed']);
    expect(server.values(`${documentUrl}#step`, 'urn:message')).toEqual(['preserve this step']);
  });

  it('grants a continuation lease to only one independent client', async () => {
    const server = documentServer(seed('waiting_input'));
    const first = client(server.makeFetch(true)); const second = client(server.makeFetch());
    const waiting = { ...run('waiting_input'), metadata: { waitingTool: { itemId: 'tool-one' } } };
    const item: ClientToolContinuationClaim['item'] = { id: 'tool-one', thread_id: waiting.thread,
      type: 'client_tool_call', created_at: 1, status: 'pending',
      call_id: 'call-one', name: 'request_approval', arguments: '{}', metadata: { runId } };
    for (const candidate of [first, second]) {
      vi.spyOn(candidate.store, 'loadRun').mockImplementation(async () => ({ ...waiting }));
      vi.spyOn(candidate.store, 'loadItem').mockResolvedValue(item);
    }
    const input = { threadRef: { thread_id: waiting.thread }, itemId: item.id, leaseExpiresAt: 100, now: 2 };
    const pending = first.store.claimClientToolContinuation({ ...input, claimId: 'first' }, first.context);
    await server.reached.promise;
    const winner = await second.store.claimClientToolContinuation({ ...input, claimId: 'second' }, second.context);
    server.release.resolve();
    expect(await pending).toBeUndefined();
    expect(winner?.claimId).toBe('second');
    expect(server.values(iri, Run.columns.leaseOwner.options.predicate!)).toEqual(['second']);
    const saveItem = vi.spyOn(second.store, 'saveItem').mockResolvedValue();
    expect(await second.store.releaseClientToolContinuation(winner!, 3, second.context)).toBe(true);
    expect(server.values(iri, Run.columns.leaseOwner.options.predicate!)).toEqual([]);
    expect(saveItem).toHaveBeenCalledOnce();
  });

  it('does not release a stale continuation back to waiting after cancellation', async () => {
    const server = documentServer(`${seed()} <${iri}> <${Run.columns.leaseOwner.options.predicate}> "claim-one".`);
    const first = client(server.makeFetch(true)); const second = client(server.makeFetch());
    const claim: ClientToolContinuationClaim = { claimId: 'claim-one', threadRef: { thread_id: run().thread },
      run: { ...run('waiting_input'), leaseOwner: 'claim-one' }, item: {
        id: 'tool-one', thread_id: run().thread, type: 'client_tool_call', created_at: 1,
        status: 'pending', call_id: 'call-one', name: 'request_approval', arguments: '{}',
      } };
    const saveItem = vi.spyOn(first.store, 'saveItem').mockResolvedValue();
    const pending = first.store.releaseClientToolContinuation(claim, 3, first.context);
    await server.reached.promise;
    await second.store.saveRun({ ...run(), status: 'cancelled', cancelRequestedAt: 123 }, second.context);
    server.release.resolve();
    expect(await pending).toBe(false);
    expect(server.values(iri, statusPredicate)).toEqual(['cancelled']);
    expect(saveItem).not.toHaveBeenCalled();
  });

  it.each(['', 'W/"1"'])('fails closed for an unavailable strong ETag (%s)', async validator => {
    const server = documentServer(seed()); server.setValidator(validator);
    const first = client(server.makeFetch());
    await expect(first.store.saveRun({ ...run(), status: 'failed' }, first.context)).rejects.toThrow('strong document ETag');
    expect(server.puts).toBe(0);
  });

  it('does not reopen an approval Session completed by another client', async () => {
    const session = { id: '2026/10/01/sessions.ttl#run_one', owner, thread: run().thread,
      tool: 'pi', status: 'paused' as const, createdAt: new Date(1000), updatedAt: new Date(1000) };
    const sessionIri = sessionResource.buildIri(pod, { id: session.id });
    const predicate = sessionResource.columns.status.options.predicate!;
    const server = documentServer(`<${sessionIri}> a <${sessionResource.config.type}>; <${predicate}> "paused".`);
    const first = client(server.makeFetch(true), session); const second = client(server.makeFetch(), session);
    const pending = first.store.saveRunApprovalSession({ ...session, status: 'active' }, first.context);
    await server.reached.promise;
    await second.store.saveRunApprovalSession({ ...session, status: 'completed' }, second.context);
    server.release.resolve(); await pending;
    expect(server.conflicts).toBe(1);
    expect(server.values(sessionIri, predicate)).toEqual(['completed']);
  });
});
