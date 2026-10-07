/**
 * Closed wire contract for the bounded A1 server-side authorization observation.
 *
 * This is NOT a guarded/empty SPARQL update and NOT a generic fetch/proof facility. It is a strict,
 * exact-key request/response record for `application/vnd.xpod.authorization-observation+json` on the
 * existing authenticated room sidecar. Every IRI is validated with the existing canonical-URL rules;
 * the parser refuses credential-bearing, escaping, non-canonical or unexpected keys. The response
 * carries only the requester/target/source identity, the complete actual guarded policy snapshot and
 * exactly one boolean read row per ordinary resource — never policy RDF bodies or credentials.
 */
import { guardedPolicyIri, parseGuardedPolicySnapshot, type GuardedPolicyProfile, type GuardedPolicySnapshot } from './GuardedPolicySnapshot';

export const AUTHORIZATION_OBSERVATION_MEDIA_TYPE = 'application/vnd.xpod.authorization-observation+json';
export const AUTHORIZATION_OBSERVATION_PROFILE = 'acp-agent-read-v1';
/**
 * A2N profile qualification wire. The negotiation request is a fixed closed record; the declaration
 * is the server's positive statement of its actual installed maintained builtin guarded profile. It
 * is qualification only — never an effective Read proof, guard proof, delta receipt or source update.
 */
export const AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE = 'application/vnd.xpod.authorization-profile-negotiation+json';
export const AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE = 'application/vnd.xpod.authorization-profile+json';
export const AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE = 'a2-profile-negotiation-v1';
export const AUTHORIZATION_PROFILE_DECLARATION_PROFILE = 'a2-profile-declaration-v1';

export interface AuthorizationObservationRequest {
  version: 1;
  profile: typeof AUTHORIZATION_OBSERVATION_PROFILE;
  sourceIri: string;
  expectedSourceDigest: string;
  targetWebId: string;
  contextDigest: string;
  challenge: string;
}

export interface AuthorizationObservationReadRow {
  iri: string;
  allowed: boolean;
}

export interface AuthorizationObservationResponse {
  version: 1;
  profile: typeof AUTHORIZATION_OBSERVATION_PROFILE;
  requesterWebId: string;
  targetWebId: string;
  sourceIri: string;
  sourceDigest: string;
  contextDigest: string;
  challenge: string;
  guard: GuardedPolicySnapshot;
  read: AuthorizationObservationReadRow[];
}

/** Closed A2N negotiation request. Exact keys match A1 except the fixed negotiation profile. */
export interface AuthorizationProfileNegotiationRequest {
  version: 1;
  profile: typeof AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE;
  sourceIri: string;
  expectedSourceDigest: string;
  targetWebId: string;
  contextDigest: string;
  challenge: string;
}

/** Closed A2N declaration. Contains only the actual guarded profile and echoed identities/digests. */
export interface AuthorizationProfileDeclaration {
  version: 1;
  profile: typeof AUTHORIZATION_PROFILE_DECLARATION_PROFILE;
  guardedPolicyProfile: GuardedPolicyProfile;
  requesterWebId: string;
  targetWebId: string;
  sourceIri: string;
  sourceDigest: string;
  contextDigest: string;
  challenge: string;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('Malformed authorization observation record');
  }
  return value as Record<string, unknown>;
}

function lowerHex(value: unknown, length: number, label: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/u.test(value)) {
    throw new Error(`Unsupported ${label}`);
  }
  return value;
}

/**
 * Canonical http(s) IRI under an explicit identity-vs-document distinction.
 * - `fragment`: a full source/WebID identity keeps its fragment; a physical document refuses one.
 * - `query`: a WebID identity may carry a query component (a distinct agent identity); a routing or
 *   source IRI never may.
 * Credentials, escaped dot/slash and non-canonical hrefs are always refused, and the original string
 * is returned byte-for-byte (never stripped, normalized or aliased into another identity).
 */
function observationIri(value: unknown, access: { fragment: boolean; query: boolean }, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || /%(?:2e|2f|5c|25)/iu.test(value) || /\\/u.test(value)) {
    throw new Error(`Unsupported ${label}`);
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Unsupported ${label}`); }
  if (![ 'http:', 'https:' ].includes(url.protocol) || url.username || url.password || url.href !== value) {
    throw new Error(`Unsupported ${label}`);
  }
  if (!access.query && url.search) throw new Error(`Unsupported ${label}`);
  if (!access.fragment && url.hash) throw new Error(`Unsupported ${label}`);
  return value;
}

/**
 * Shared closed identity-request parser. The A1 observation request and the A2N negotiation request
 * share the exact key set and identity/digest rules; only the fixed profile differs. This is not a
 * generic caller-label constructor: the profile is a module constant, never caller-supplied.
 */
function parseIdentityRequest<TProfile extends string>(
  value: unknown,
  profile: TProfile,
  label: string,
): { version: 1; profile: TProfile; sourceIri: string; expectedSourceDigest: string; targetWebId: string; contextDigest: string; challenge: string } {
  const input = record(value, [ 'version', 'profile', 'sourceIri', 'expectedSourceDigest', 'targetWebId', 'contextDigest', 'challenge' ]);
  if (input.version !== 1 || input.profile !== profile) {
    throw new Error(`Unsupported ${label} profile`);
  }
  const sourceIri = observationIri(input.sourceIri, { fragment: true, query: false }, `${label} source IRI`);
  const physicalDocumentIri = sourceIri.includes('#') ? sourceIri.slice(0, sourceIri.indexOf('#')) : sourceIri;
  guardedPolicyIri(physicalDocumentIri);
  return {
    version: 1,
    profile,
    sourceIri,
    expectedSourceDigest: lowerHex(input.expectedSourceDigest, 64, `${label} expected source digest`),
    targetWebId: observationIri(input.targetWebId, { fragment: true, query: true }, `${label} target WebID`),
    contextDigest: lowerHex(input.contextDigest, 64, `${label} context digest`),
    challenge: lowerHex(input.challenge, 32, `${label} challenge`),
  };
}

export function parseAuthorizationObservationRequest(value: unknown): AuthorizationObservationRequest {
  return parseIdentityRequest(value, AUTHORIZATION_OBSERVATION_PROFILE, 'authorization observation');
}

export function parseAuthorizationProfileNegotiationRequest(value: unknown): AuthorizationProfileNegotiationRequest {
  return parseIdentityRequest(value, AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE, 'authorization profile negotiation');
}

/** The physical document of a full source identity; the server never trusts a caller-selected one. */
export function physicalDocumentIriOf(sourceIri: string): string {
  return sourceIri.includes('#') ? sourceIri.slice(0, sourceIri.indexOf('#')) : sourceIri;
}

/** Closed response serialization with the exact key order and no per-resource extras. */
export function serializeAuthorizationObservationResponse(response: AuthorizationObservationResponse): string {
  return JSON.stringify({
    version: response.version,
    profile: response.profile,
    requesterWebId: response.requesterWebId,
    targetWebId: response.targetWebId,
    sourceIri: response.sourceIri,
    sourceDigest: response.sourceDigest,
    contextDigest: response.contextDigest,
    challenge: response.challenge,
    guard: response.guard,
    read: response.read.map(row => ({ iri: row.iri, allowed: row.allowed })),
  });
}

/**
 * Closed declaration parser. Exact key set and byte-for-byte identities; the guarded profile is one
 * of the two maintained builtin profiles and nothing else. This is used by clients (and own tests)
 * to reject any partial/extra/unqualified declaration; the server serializer is the only producer.
 */
export function parseAuthorizationProfileDeclaration(value: unknown): AuthorizationProfileDeclaration {
  const input = record(value, [ 'version', 'profile', 'guardedPolicyProfile', 'requesterWebId', 'targetWebId',
    'sourceIri', 'sourceDigest', 'contextDigest', 'challenge' ]);
  if (input.version !== 1 || input.profile !== AUTHORIZATION_PROFILE_DECLARATION_PROFILE) {
    throw new Error('Unsupported authorization profile declaration');
  }
  const guardedPolicyProfile = input.guardedPolicyProfile;
  if (guardedPolicyProfile !== 'wac-ground-v1' && guardedPolicyProfile !== 'acp-ground-v1') {
    throw new Error('Unsupported declaration guarded policy profile');
  }
  return {
    version: 1,
    profile: AUTHORIZATION_PROFILE_DECLARATION_PROFILE,
    guardedPolicyProfile,
    requesterWebId: observationIri(input.requesterWebId, { fragment: true, query: true }, 'declaration requester WebID'),
    targetWebId: observationIri(input.targetWebId, { fragment: true, query: true }, 'declaration target WebID'),
    sourceIri: observationIri(input.sourceIri, { fragment: true, query: false }, 'declaration source IRI'),
    sourceDigest: lowerHex(input.sourceDigest, 64, 'declaration source digest'),
    contextDigest: lowerHex(input.contextDigest, 64, 'declaration context digest'),
    challenge: lowerHex(input.challenge, 32, 'declaration challenge'),
  };
}

/**
 * Closed client parser for the A1 ACP observation response. Exact key set, byte-for-byte identities
 * and the SAME pure guard validator as the guarded update envelope. `read` must be an exact
 * bijection with `guard.resources`: exactly one boolean row per ordinary resource, no
 * missing/extra/duplicate. Any unknown key, malformed identity/digest/row or inventory mismatch
 * throws; the caller fails closed and never treats an unqualified body as a Read result.
 */
export function parseAuthorizationObservationResponse(value: unknown): AuthorizationObservationResponse {
  const input = record(value, [ 'version', 'profile', 'requesterWebId', 'targetWebId', 'sourceIri', 'sourceDigest',
    'contextDigest', 'challenge', 'guard', 'read' ]);
  if (input.version !== 1 || input.profile !== AUTHORIZATION_OBSERVATION_PROFILE) {
    throw new Error('Unsupported authorization observation response profile');
  }
  const guard = parseGuardedPolicySnapshot(input.guard);
  if (!Array.isArray(input.read)) throw new Error('Malformed authorization observation read rows');
  const read = input.read.map(row => {
    const entry = record(row, [ 'iri', 'allowed' ]);
    if (typeof entry.allowed !== 'boolean') throw new Error('Malformed authorization observation read value');
    return { iri: guardedPolicyIri(entry.iri), allowed: entry.allowed };
  });
  const resourceIris = new Set(guard.resources.map(resource => resource.iri));
  if (read.length !== resourceIris.size || new Set(read.map(row => row.iri)).size !== read.length
    || read.some(row => !resourceIris.has(row.iri))) {
    throw new Error('Authorization observation read rows are not a bijection of the guarded inventory');
  }
  return {
    version: 1,
    profile: AUTHORIZATION_OBSERVATION_PROFILE,
    requesterWebId: observationIri(input.requesterWebId, { fragment: true, query: true }, 'observation requester WebID'),
    targetWebId: observationIri(input.targetWebId, { fragment: true, query: true }, 'observation target WebID'),
    sourceIri: observationIri(input.sourceIri, { fragment: true, query: false }, 'observation source IRI'),
    sourceDigest: lowerHex(input.sourceDigest, 64, 'observation source digest'),
    contextDigest: lowerHex(input.contextDigest, 64, 'observation context digest'),
    challenge: lowerHex(input.challenge, 32, 'observation challenge'),
    guard,
    read,
  };
}

/** Closed declaration serialization with the exact key order. No guard/read/policy/credentials. */
export function serializeAuthorizationProfileDeclaration(declaration: AuthorizationProfileDeclaration): string {
  return JSON.stringify({
    version: declaration.version,
    profile: declaration.profile,
    guardedPolicyProfile: declaration.guardedPolicyProfile,
    requesterWebId: declaration.requesterWebId,
    targetWebId: declaration.targetWebId,
    sourceIri: declaration.sourceIri,
    sourceDigest: declaration.sourceDigest,
    contextDigest: declaration.contextDigest,
    challenge: declaration.challenge,
  });
}
