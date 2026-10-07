import { isDeepStrictEqual } from 'node:util';
import { isSolidAuth } from '../auth/AuthContext';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { TaskCredentialStore } from '../tasks/TaskCredentialStore';
import { CanonicalRoomSource, copyImmutableCanonicalRoomSnapshot, parseMembershipAuthorityBinding, type CanonicalRoomFacts, type CanonicalRoomSnapshot, type MembershipAuthorityBinding } from './canonicalRoomSource';
import { decodeSourceBoundRoomId } from './canonicalRoomIdentity';
import { createNamedCanonicalRead } from './namedCanonicalRead';
import { MembershipAuthorityLocator, type MembershipAuthorityCandidate } from './membershipAuthorityLocator';
import { MatrixError } from './MatrixError';
import type { MatrixStoreContext } from './types';

export interface MembershipAuthorityResolverOptions {
  canonicalSource: Pick<CanonicalRoomSource, 'readSnapshot' | 'readNamedSnapshot'>;
  locator: Pick<MembershipAuthorityLocator, 'remember' | 'find' | 'forget'>;
  credentials: Pick<TaskCredentialStore, 'lease'>;
  podAccess: PodAccessFetchProvider;
  issuer: string;
}

/** Internal proof only; no authenticated fetch and no generic write capability is returned. */
export interface MembershipAuthorityProof {
  readonly actorWebId: string;
  readonly transportOwnerWebId: string;
  readonly binding: MembershipAuthorityBinding;
  readonly facts: CanonicalRoomFacts;
  readonly snapshot: CanonicalRoomSnapshot;
}
const proofs = new WeakSet<object>();
export function isMembershipAuthorityProof(value: unknown): value is MembershipAuthorityProof {
  return !!value && typeof value === 'object' && proofs.has(value);
}

function requireActor(context: MatrixStoreContext): void {
  if (context.service || !context.auth || !isSolidAuth(context.auth) || context.auth.webId !== context.webId) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'Membership authority requires the original authenticated actor');
  }
}
function candidateFor(facts: CanonicalRoomFacts): MembershipAuthorityCandidate | undefined {
  if (!facts.membershipAuthority) return undefined;
  return { sourceIri: facts.sourceIri, sourcePodId: facts.sourcePodId, sourceRoot: facts.sourcePodUrl,
    ownerWebId: facts.authorWebId, binding: facts.membershipAuthority };
}

export class MembershipAuthorityResolver {
  public constructor(private readonly options: MembershipAuthorityResolverOptions) {}

  public async readAsCaller(roomId: string, context: MatrixStoreContext): Promise<CanonicalRoomFacts> {
    requireActor(context);
    const { facts } = await this.options.canonicalSource.readSnapshot(roomId, context);
    const candidate = candidateFor(facts);
    if (candidate && (facts.authorWebId === context.webId || facts.participants.includes(context.webId))) {
      await this.options.locator.remember(candidate);
    }
    return facts;
  }

  public async resolveForMembership(roomId: string, actor: MatrixStoreContext, signal?: AbortSignal): Promise<MembershipAuthorityProof> {
    const checkSignal = (): void => { if (signal?.aborted) throw signal.reason; };
    checkSignal();
    requireActor(actor);
    const decoded = decodeSourceBoundRoomId(roomId);
    if (decoded.status !== 'source-bound') throw new MatrixError(403, 'M_FORBIDDEN', 'Membership requires an exact source-bound room');
    const candidate = await this.options.locator.find(decoded.canonicalChatIri);
    checkSignal();
    if (!candidate) throw new MatrixError(403, 'M_FORBIDDEN', 'No trusted membership candidate is available');
    try {
      if (candidate.sourceIri !== decoded.canonicalChatIri || !parseMembershipAuthorityBinding(candidate.binding)
        || candidate.binding.issuer !== this.options.issuer) {
        throw new MatrixError(403, 'M_FORBIDDEN', 'The candidate does not name this deployment authority');
      }
      const beforeRequest = async(): Promise<void> => {
        checkSignal();
        const lease = await this.options.credentials.lease({ credentialRef: candidate.binding.credentialRef,
          ownerWebId: candidate.ownerWebId, version: candidate.binding.version, recordUsage: false });
        if (lease.credentialRef !== candidate.binding.credentialRef || lease.ownerWebId !== candidate.ownerWebId
          || lease.version !== candidate.binding.version || lease.issuer !== this.options.issuer) {
          throw new MatrixError(403, 'M_FORBIDDEN', 'Current named membership lease differs');
        }
        checkSignal();
      };
      await beforeRequest();
      const authenticated = await this.options.podAccess.getPodFetch(candidate.ownerWebId, {
        taskCredential: { credentialRef: candidate.binding.credentialRef, version: candidate.binding.version },
        podBaseUrl: candidate.sourceRoot, beforeRequest,
      });
      checkSignal();
      if (!authenticated) throw new MatrixError(403, 'M_FORBIDDEN', 'Named membership transport is unavailable');
      const guarded: typeof fetch = signal ? async(input, init) => {
        await beforeRequest(); checkSignal();
        return await authenticated(input, { ...init, signal, redirect: 'error' });
      } : authenticated;
      const capability = await createNamedCanonicalRead({ ...candidate, fetch: guarded, beforeRequest });
      const snapshot = await this.options.canonicalSource.readNamedSnapshot(roomId, capability);
      checkSignal();
      if (!isDeepStrictEqual(candidateFor(snapshot.facts), candidate)
        || snapshot.facts.membershipAuthorityPublication?.state !== 'complete') {
        throw new MatrixError(403, 'M_FORBIDDEN', 'Current canonical membership authority differs or is pending');
      }
      const evidence = copyImmutableCanonicalRoomSnapshot(snapshot);
      const proof = Object.defineProperties({ actorWebId: actor.webId, transportOwnerWebId: candidate.ownerWebId,
        binding: Object.freeze({ ...candidate.binding }) }, {
        // Evidence remains available to internal lifecycle code, but is never an HTTP JSON payload.
        facts: { value: evidence.facts, enumerable: false },
        snapshot: { value: evidence, enumerable: false },
      }) as MembershipAuthorityProof;
      Object.freeze(proof);
      proofs.add(proof);
      return proof;
    } catch {
      // A cancelled observation did not establish that this authority candidate changed.
      checkSignal();
      await this.options.locator.forget(candidate.sourceIri);
      throw new MatrixError(403, 'M_FORBIDDEN', 'Current named membership authority could not be proven');
    }
  }
}
