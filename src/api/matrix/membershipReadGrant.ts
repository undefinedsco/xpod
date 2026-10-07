import { createHash } from 'node:crypto';
import { parseMembershipAuthorityBinding, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { hasExactKeys as keys, isHttpIri as httpIri, isMilliseconds as milliseconds,
  isNonblank as nonblank, isRecord as record } from './membershipControlValidation';

/**
 * Durable membership Read-grant ownership, stored under the existing `metadata.protocols.matrix`
 * application control state (like `membershipOperation`). It records that *this* deployment
 * created a specific authorization resource for a specific source-bound join operation, so shape
 * alone never claims a byte-identical pre-existing node. No local Solid schema/table and no new
 * dependency.
 */
export interface MembershipReadGrant {
  actorWebId: string;
  sourceIri: string;
  joinOperationId: string;
  authorPodUrl: { webId: string; podUrl: string };
  binding: MembershipAuthorityBinding;
  createdAt: number;
  state: 'reserved' | 'installed';
  /**
   * Explicit application control profile, assigned by the successful guarded Read mark atomically with
   * policyIri/authorizationIri. Absent while reserved and absent on legacy installed records (which are
   * only ever reinterpreted on the WAC branch). Never inferred from an IRI/suffix.
   */
  readProfile?: 'wac-ground-v1' | 'acp-ground-v1';
  /** Assigned by the ACL delta when it observes the exact selected policy; absent while reserved. */
  policyIri?: string;
  authorizationIri?: string;
}
export type MembershipReadGrants = Record<string, MembershipReadGrant>;

export function parseMembershipReadGrant(value: unknown): MembershipReadGrant | undefined {
  const fields = ['actorWebId', 'sourceIri', 'joinOperationId', 'authorPodUrl', 'binding', 'createdAt', 'state'];
  const hasPolicy = record(value) && Object.prototype.hasOwnProperty.call(value, 'policyIri');
  const hasProfile = record(value) && Object.prototype.hasOwnProperty.call(value, 'readProfile');
  if (!keys(value, [...fields, ...(hasPolicy ? ['policyIri', 'authorizationIri'] : []), ...(hasProfile ? ['readProfile'] : [])])
    || !httpIri(value.actorWebId) || !httpIri(value.sourceIri) || !nonblank(value.joinOperationId)
    || !keys(value.authorPodUrl, ['webId', 'podUrl']) || !httpIri(value.authorPodUrl.webId) || !httpIri(value.authorPodUrl.podUrl)
    || !milliseconds(value.createdAt) || (value.state !== 'reserved' && value.state !== 'installed')) return undefined;
  const binding = parseMembershipAuthorityBinding(value.binding);
  if (!binding) return undefined;
  let readProfile: MembershipReadGrant['readProfile'];
  if (hasProfile) {
    if (value.readProfile !== 'wac-ground-v1' && value.readProfile !== 'acp-ground-v1') return undefined;
    readProfile = value.readProfile;
  }
  let policyIri: string | undefined;
  let authorizationIri: string | undefined;
  if (hasPolicy) {
    if (!httpIri(value.policyIri) || !httpIri(value.authorizationIri)
      || value.authorizationIri.split('#')[0] !== value.policyIri) return undefined;
    policyIri = value.policyIri; authorizationIri = value.authorizationIri;
  } else if (value.state === 'installed') return undefined;
  return { actorWebId: value.actorWebId, sourceIri: value.sourceIri, joinOperationId: value.joinOperationId,
    authorPodUrl: { webId: value.authorPodUrl.webId, podUrl: value.authorPodUrl.podUrl },
    binding, createdAt: value.createdAt, state: value.state,
    ...(readProfile ? { readProfile } : {}), ...(policyIri ? { policyIri, authorizationIri } : {}) };
}
export function parseMembershipReadGrants(value: unknown): MembershipReadGrants | undefined {
  if (!record(value)) return undefined;
  const entries: Array<[string, MembershipReadGrant]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (!httpIri(key)) return undefined;
    const grant = parseMembershipReadGrant(value[key]);
    if (!grant || grant.actorWebId !== key) return undefined;
    entries.push([key, grant]);
  }
  return Object.fromEntries(entries);
}
/**
 * Distinct authorization resource per (policy, actor, join operation, full source IRI). The source
 * IRI — including any `#fragment` — is part of the canonical identity so two source fragments that
 * share a document, policy, actor and operation key never collide. The tuple is serialized as an
 * unambiguous JSON array, not newline concatenation.
 */
export function grantAuthorizationIri(policyIri: string, actorWebId: string, joinOperationId: string, sourceIri: string): string {
  const tuple = JSON.stringify([ actorWebId, joinOperationId, sourceIri, policyIri ]);
  return `${policyIri}#membership-read-${createHash('sha256').update(tuple).digest('hex').slice(0, 32)}`;
}
export function findMembershipReadGrant(grants: MembershipReadGrants | undefined, actorWebId: string): MembershipReadGrant | undefined {
  return grants?.[actorWebId];
}
