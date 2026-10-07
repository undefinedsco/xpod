import type { ChatMemberRole } from '@undefineds.co/models';
import { parseMembershipAuthorityBinding, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { hasExactKeys as keys, isHttpIri as httpIri, isMilliseconds as milliseconds,
  isNonblank as nonblank, isRecord as record } from './membershipControlValidation';

export interface MembershipInvitation { id: string; inviterWebId: string; createdAt: number }
export type MembershipInvitations = Record<string, MembershipInvitation>;
export type MembershipOperationKind = 'invite' | 'join' | 'leave';
export type MembershipOperationPhase = 'join-read-pending' | 'leave-read-pending' | 'leave-roster-pending' | 'committed' | 'complete';
export interface MembershipOperation {
  format: 1;
  operationId: string;
  kind: MembershipOperationKind;
  phase: MembershipOperationPhase;
  actor: { webId: string; podUrl: string };
  targetWebId: string;
  authority: MembershipAuthorityBinding | null;
  expected: { authorWebId: string; participants: string[]; memberRoles: Record<string, ChatMemberRole> | null;
    invitation: MembershipInvitation | null };
  event: { createdAt: number; content: { membership: MembershipOperationKind } };
  ownerRecovery: { generation: number; binding: MembershipAuthorityBinding } | null;
}

export function parseMembershipInvitation(value: unknown): MembershipInvitation | undefined {
  if (!keys(value, ['id', 'inviterWebId', 'createdAt']) || !nonblank(value.id)
    || !httpIri(value.inviterWebId) || !milliseconds(value.createdAt)) return undefined;
  return { id: value.id, inviterWebId: value.inviterWebId, createdAt: value.createdAt };
}
export function parseMembershipInvitations(value: unknown): MembershipInvitations | undefined {
  if (!record(value)) return undefined;
  const entries: Array<[string, MembershipInvitation]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (!httpIri(key)) return undefined;
    const invitation = parseMembershipInvitation(value[key]);
    if (!invitation) return undefined;
    entries.push([key, invitation]);
  }
  return Object.fromEntries(entries);
}
export function parseMembershipOperation(value: unknown): MembershipOperation | undefined {
  if (!keys(value, ['format', 'operationId', 'kind', 'phase', 'actor', 'targetWebId', 'authority', 'expected', 'event', 'ownerRecovery'])
    || value.format !== 1 || !nonblank(value.operationId)
    || typeof value.kind !== 'string' || !['invite', 'join', 'leave'].includes(value.kind) || !httpIri(value.targetWebId)
    || !keys(value.actor, ['webId', 'podUrl']) || !httpIri(value.actor.webId) || !httpIri(value.actor.podUrl)) return undefined;
  const kind = value.kind as MembershipOperationKind;
  const phases = kind === 'invite' ? ['committed', 'complete'] : kind === 'join'
    ? ['join-read-pending', 'committed', 'complete'] : ['leave-read-pending', 'leave-roster-pending', 'committed', 'complete'];
  if (typeof value.phase !== 'string' || !phases.includes(value.phase)) return undefined;
  const authority = value.authority === null ? null : parseMembershipAuthorityBinding(value.authority);
  if (authority === undefined || (authority === null && kind !== 'invite')) return undefined;
  const expected = value.expected;
  if (!keys(expected, ['authorWebId', 'participants', 'memberRoles', 'invitation'])
    || !httpIri(expected.authorWebId) || !Array.isArray(expected.participants)
    || !expected.participants.every(httpIri) || new Set(expected.participants).size !== expected.participants.length) return undefined;
  let memberRoles: Record<string, ChatMemberRole> | null = null;
  if (expected.memberRoles !== null) {
    if (!record(expected.memberRoles)) return undefined;
    const entries: Array<[string, ChatMemberRole]> = [];
    for (const key of Reflect.ownKeys(expected.memberRoles)) {
      if (!httpIri(key) || typeof expected.memberRoles[key] !== 'string'
        || !['owner', 'admin', 'member'].includes(expected.memberRoles[key] as string)) return undefined;
      entries.push([key, expected.memberRoles[key] as ChatMemberRole]);
    }
    memberRoles = Object.fromEntries(entries);
  }
  const invitation = expected.invitation === null ? null : parseMembershipInvitation(expected.invitation);
  if (invitation === undefined || !keys(value.event, ['createdAt', 'content']) || !milliseconds(value.event.createdAt)
    || !keys(value.event.content, ['membership']) || value.event.content.membership !== kind) return undefined;
  let ownerRecovery: MembershipOperation['ownerRecovery'] = null;
  if (value.ownerRecovery !== null) {
    if (!keys(value.ownerRecovery, ['generation', 'binding']) || typeof value.ownerRecovery.generation !== 'number'
      || !Number.isSafeInteger(value.ownerRecovery.generation) || value.ownerRecovery.generation <= 0) return undefined;
    const binding = parseMembershipAuthorityBinding(value.ownerRecovery.binding);
    if (!binding) return undefined;
    ownerRecovery = { generation: value.ownerRecovery.generation, binding };
  }
  return { format: 1, operationId: value.operationId, kind, phase: value.phase as MembershipOperationPhase,
    actor: { webId: value.actor.webId, podUrl: value.actor.podUrl }, targetWebId: value.targetWebId, authority,
    expected: { authorWebId: expected.authorWebId, participants: [...expected.participants], memberRoles, invitation },
    event: { createdAt: value.event.createdAt, content: { membership: kind } }, ownerRecovery };
}
