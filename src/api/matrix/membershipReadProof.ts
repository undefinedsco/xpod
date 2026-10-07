// The observation module alone owns the sealed dataset; this is its narrow proof surface.
export { proveMembershipEffectiveRead } from './membershipPolicyObservation';
export type { MembershipEffectiveReadProof, MembershipResourceRead,
  MembershipAcpEffectiveReadProof, MembershipAcpResourceRead, MembershipAgentReadProof } from './membershipPolicyObservation';
