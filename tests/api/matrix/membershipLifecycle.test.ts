import { describe, expect, it, vi } from 'vitest';
import { MembershipLifecycle, type MembershipInviteProjectEvent } from '../../../src/api/matrix/membershipLifecycle';
import type { MembershipInviteSourcePort, MembershipSourceEvidence } from '../../../src/api/matrix/canonicalMembershipSource';
import type { MembershipOperation } from '../../../src/api/matrix/membershipOperation';
import type { CanonicalRoomFacts } from '../../../src/api/matrix/canonicalRoomSource';
import type { MatrixEventRecord, MatrixStoreContext } from '../../../src/api/matrix/types';

const owner = 'https://owner.example/profile#me';
const target = 'https://target.example/profile#me';
const actor: MatrixStoreContext = { webId: owner, podUrl: 'https://owner.example/pod/', auth: { type: 'solid', webId: owner } };
function fixture() {
  const facts: CanonicalRoomFacts = { roomId: '!source', sourceIri: 'https://owner.example/pod/chat/index.ttl#this',
    sourcePodId: 'pod', sourcePodUrl: actor.podUrl!, authorWebId: owner, participants: [owner], memberRoles: {} };
  const evidence = (): MembershipSourceEvidence => ({ facts: structuredClone(facts) });
  const reserve = vi.fn(async(_expected: MembershipSourceEvidence, intent: { operationId: string; createdAt: number; targetWebId: string }) => {
    facts.membershipOperation = operation(intent.targetWebId, intent.operationId, intent.createdAt);
    facts.membershipInvitations = { ...facts.membershipInvitations,
      [intent.targetWebId]: { id: intent.operationId, inviterWebId: owner, createdAt: intent.createdAt } };
    return evidence();
  });
  const complete = vi.fn(async() => { facts.membershipOperation!.phase = 'complete'; return evidence(); });
  const confirm = vi.fn(async() => evidence());
  const port: MembershipInviteSourcePort = { actor: { webId: owner, podUrl: actor.podUrl! },
    readCurrent: async() => evidence(), confirmOperation: confirm, reserveInvite: reserve, completeInvite: complete };
  const source = { open: vi.fn(async() => port) };
  const event = (op: MembershipOperation): MatrixEventRecord => ({ eventId: op.operationId, roomId: facts.roomId,
    type: 'm.room.member', sender: op.actor.webId, originServerTs: op.event.createdAt, stateKey: op.targetWebId,
    content: op.event.content, resourceId: 'chat/day/messages.ttl#original', event: { event_id: op.operationId,
      room_id: facts.roomId, type: 'm.room.member', sender: op.actor.webId, origin_server_ts: op.event.createdAt,
      state_key: op.targetWebId, content: op.event.content, prev_events: ['first-head'] } });
  const project = vi.fn<Parameters<MembershipInviteProjectEvent>, ReturnType<MembershipInviteProjectEvent>>(async input => {
    const winner = event(input.operation as MembershipOperation);
    await input.validateCommitted(winner);
    return winner;
  });
  const service = new MembershipLifecycle({ source, now: () => 123, eventId: () => '$intent' });
  return { facts, source, reserve, complete, confirm, project, service, event };
}
function operation(webId = target, id = '$old', time = 1): MembershipOperation {
  return { format: 1, operationId: id, kind: 'invite', phase: 'committed', actor: { webId: owner, podUrl: actor.podUrl! },
    targetWebId: webId, authority: null, expected: { authorWebId: owner, participants: [owner], memberRoles: null, invitation: null },
    event: { createdAt: time, content: { membership: 'invite' } }, ownerRecovery: null };
}

describe('invite foundation bounded callback decisions (not native Pod projection)', () => {
  it('validates a full target before opening any source', async() => {
    const f = fixture();
    await expect(f.service.invite('!source', 'bob', actor, f.project)).rejects.toMatchObject({ status: 400 });
    expect(f.source.open).not.toHaveBeenCalled();
  });
  it('reserves invitation only and completes after strict projection', async() => {
    const f = fixture();
    const result = await f.service.invite('!source', target, actor, f.project);
    expect(result.kind).toBe('invited');
    expect(f.facts.participants).toEqual([owner]); expect(f.facts.memberRoles).toEqual({});
    expect(f.facts.membershipInvitations?.[target]).toEqual({ id: '$intent', inviterWebId: owner, createdAt: 123 });
    expect(f.facts.membershipOperation?.phase).toBe('complete');
    expect(f.project.mock.calls[0][0].actor).toEqual(actor);
    expect(f.project.mock.calls[0][0]).not.toHaveProperty('fetch');
  });
  it.each(['joined', 'outsider', 'member', 'orphan-admin'])('rejects %s with no source mutation or projection', async mode => {
    const f = fixture();
    if (mode === 'joined') f.facts.participants = [owner, target];
    if (mode === 'outsider') f.facts.participants = [];
    if (mode === 'member') { f.facts.authorWebId = target; f.facts.memberRoles = { [owner]: 'member' }; }
    if (mode === 'orphan-admin') { f.facts.authorWebId = target; f.facts.participants = []; f.facts.memberRoles = { [owner]: 'admin' }; }
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 403 });
    expect(f.reserve).not.toHaveBeenCalled(); expect(f.project).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it('already invited retains a private old complete slot without reading its PDU', async() => {
    const f = fixture(); f.facts.membershipOperation = { ...operation(), phase: 'complete' };
    f.facts.membershipInvitations = { [target]: { id: '$old', inviterWebId: target, createdAt: 1 } };
    expect(await f.service.invite('!source', target, actor, f.project)).toEqual({ kind: 'already-invited' });
    expect(f.project).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it('resumes the frozen original intent after a projection response is lost', async() => {
    const f = fixture(); f.project.mockRejectedValueOnce(new Error('response lost'));
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 409 });
    expect(f.facts.membershipOperation?.phase).toBe('committed');
    const result = await f.service.invite('!source', target, actor, f.project);
    expect(result.kind).toBe('invited'); expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.project.mock.calls.map(([input]) => input.operation.operationId)).toEqual(['$intent', '$intent']);
  });
  it('a different unfinished intent blocks even an already invited target', async() => {
    const f = fixture(); f.facts.membershipOperation = operation('https://other.example/#me');
    f.facts.membershipInvitations = { [target]: { id: '$old', inviterWebId: owner, createdAt: 1 } };
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 409 });
    expect(f.project).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
  });
  it('retires a canonical complete slot without reading the historical actor PDU', async() => {
    const f = fixture(); f.facts.membershipOperation = { ...operation('https://old.example/#me'), phase: 'complete' };
    await expect(f.service.invite('!source', target, actor, f.project)).resolves.toMatchObject({ kind: 'invited' });
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.project).toHaveBeenCalledTimes(1); expect(f.project.mock.calls[0][0].existingOnly).toBe(false);
    expect(f.facts.membershipOperation.operationId).not.toBe('$old');
  });
  it('a changed current source rejects inside the adapter validator before journal work', async() => {
    const f = fixture(); const journal = vi.fn();
    f.confirm.mockResolvedValueOnce({ facts: structuredClone(f.facts) }).mockRejectedValueOnce(new Error('current phase changed'));
    f.project.mockImplementation(async input => {
      const event = f.event(input.operation as MembershipOperation);
      await input.validateCommitted(event); journal(); return event;
    });
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 409 });
    expect(journal).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it('rejects changed source before invoking an adapter that may persist immediately', async() => {
    const f = fixture(); f.confirm.mockRejectedValueOnce(new Error('roles changed'));
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 409 });
    expect(f.project).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  });
  it('missing projection fails before opening or reserving source intent', async() => {
    const f = fixture();
    await expect(f.service.invite('!source', target, actor, undefined as never)).rejects.toMatchObject({ status: 409 });
    expect(f.source.open).not.toHaveBeenCalled();
  });
  it('strict frozen timestamp and minimal content reject a wrong winner before completion', async() => {
    const f = fixture(); f.project.mockImplementation(async input => ({ ...f.event(input.operation as MembershipOperation), originServerTs: 124 }));
    await expect(f.service.invite('!source', target, actor, f.project)).rejects.toMatchObject({ status: 409 });
    expect(f.complete).not.toHaveBeenCalled();
  });
});
