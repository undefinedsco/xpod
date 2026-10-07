// The observation module alone owns the sealed access and guard; this is its narrow mutation surface.
export { applyMembershipReadDelta, assertMembershipReadDeltaEvidence,
  executeMembershipReadDeltaCas, membershipReadDeltaGrant } from './membershipPolicyObservation';
export type { MembershipReadDeltaIntent } from './membershipPolicyObservation';
