/**
 * Bounded server-only actual authorization observation capability for BOTH maintained builtin
 * guarded profiles (A1 ACP read observation and A2N WAC/ACP profile negotiation).
 *
 * This is a concrete capability from the SAME trusted builtin assembly, bound by object identity
 * to the actual injected `permissionReader`, `authorizer`, `credentialsExtractor`, quad accessor,
 * locking store, hierarchical locker and identifier/auth/auxiliary strategies. It is a trusted
 * assembly contract, NOT automatic semantic certification of arbitrary overrides: qualification
 * compares the bound objects to the handler's ACTUAL dependencies (plus `usesAuthorityLocker`) before
 * any traversal, and refuses 415 on mismatch/absence. It computes through the actual reader/authorizer
 * only — no second engine, reader registry, caller permission table or public proof.
 *
 * The bound `profile` is chosen by the single authMode-derived `conditionalAuthStrategyWiring`
 * branch, never a caller label. `handle` is the A1 ACP observation wire (ACP only, 415 otherwise);
 * `negotiate` is the positive closed A2N declaration (either maintained profile), qualification only.
 * Both share ONE bounded collection lifecycle (`runBounded`/`collectGuard`).
 *
 * A1 performs zero data writes: no native/source/policy mutation, no Matrix proof. The fresh pass
 * takes an exclusive room WRITE lock in the SAME shared hierarchy planner so it serializes an actual
 * same-room/descendant LDP writer while mutating no RDF. Reader/parse/transport/drain faults are
 * explicit unknown failures, never `allowed:false`; only a successful qualified reader followed by the
 * normal builtin authorizer Read refusal yields false.
 */
import {
  BadRequestHttpError,
  ConflictHttpError,
  ForbiddenHttpError,
  IdentifierSetMultiMap,
  INTERNAL_QUADS,
  InternalServerError,
  NotFoundHttpError,
  UnsupportedMediaTypeHttpError,
} from '@solid/community-server';
import type {
  Authorizer,
  AuxiliaryIdentifierStrategy,
  Credentials,
  CredentialsExtractor,
  ExpiringReadWriteLocker,
  HttpRequest,
  IdentifierStrategy,
  PermissionReader,
  ResourceIdentifier,
} from '@solid/community-server';
import { ACL, PERMISSIONS } from '@solidlab/policy-engine';
import type { Quad } from '@rdfjs/types';
import { GuardedPolicyClosure } from '../storage/GuardedPolicyClosure';
import type { LockingResourceStore } from '../storage/LockingResourceStore';
import type { MixDataAccessor } from '../storage/accessors/MixDataAccessor';
import type { HierarchicalReadWriteLocker } from '../storage/HierarchicalReadWriteLocker';
import type { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { metadataRequestContext } from '../storage/MetadataRequestContext';
import {
  AuthorityDependencyRetryError,
  authorityDependenciesFresh,
  collectAuthorityDependencies,
  newAuthoritySnapshotState,
  settleAuthorityReads,
  type AuthoritySnapshotState,
} from '../storage/AuthoritySnapshotContext';
import { digestGroundSource, groundPolicyQuadBytes, type GuardedPolicyProfile, type GuardedPolicySnapshot } from '../storage/rdf/GuardedPolicySnapshot';
import {
  AUTHORIZATION_OBSERVATION_PROFILE,
  AUTHORIZATION_PROFILE_DECLARATION_PROFILE,
  parseAuthorizationObservationRequest,
  parseAuthorizationProfileNegotiationRequest,
  physicalDocumentIriOf,
  serializeAuthorizationObservationResponse,
  serializeAuthorizationProfileDeclaration,
  type AuthorizationObservationReadRow,
  type AuthorizationObservationResponse,
  type AuthorizationProfileDeclaration,
  type AuthorizationProfileNegotiationRequest,
} from '../storage/rdf/AuthorizationObservation';
import { observationDispatchContext, type ObservationDispatchAudit } from './ObservationPathBasedReader';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_QUADS = 100000;
const MAX_ATTEMPTS = 3;

export interface AgentReadObservationOptions {
  permissionReader: PermissionReader;
  authorizer: Authorizer;
  credentialsExtractor: CredentialsExtractor;
  accessor: MixDataAccessor;
  authorityStore: LockingResourceStore;
  locks: HierarchicalReadWriteLocker;
  identifierStrategy: IdentifierStrategy;
  authStrategy: AuxiliaryIdentifierStrategy;
  auxiliaryStrategy: AuxiliaryIdentifierStrategy;
  /**
   * The deployed authMode-derived guarded profile this capability was assembled for. Set by the
   * single `conditionalAuthStrategyWiring` branch (never a caller label); restricted to the two
   * maintained builtin ground profiles by the constructor.
   */
  profile: GuardedPolicyProfile;
}

function isGuardedProfile(value: unknown): value is GuardedPolicyProfile {
  return value === 'wac-ground-v1' || value === 'acp-ground-v1';
}

/** The handler's actual authorization dependencies, compared before any traversal. */
export interface AgentReadObservationActual {
  permissionReader: PermissionReader;
  authorizer: Authorizer;
  credentialsExtractor: CredentialsExtractor;
  /** Actual injected quad accessor; the capability must be bound to this exact object. */
  accessor?: MixDataAccessor;
  authorityStore?: LockingResourceStore;
  locks?: ExpiringReadWriteLocker;
  identifierStrategy?: IdentifierStrategy;
  authStrategy?: AuxiliaryIdentifierStrategy;
  auxiliaryStrategy?: AuxiliaryIdentifierStrategy;
  /** Actual registered-Pod lookup used by the guarded closure; the handler constructs it. */
  podLookup?: PodLookupRepository;
}

export interface AgentReadObservationSidecar {
  basePath: string;
  baseUrl: string;
  isContainer: boolean;
}

class StaleObservationError extends Error {}

export class AgentReadObservation {
  private readonly options: AgentReadObservationOptions;

  public constructor(
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    credentialsExtractor: CredentialsExtractor,
    accessor: MixDataAccessor,
    authorityStore: LockingResourceStore,
    locks: HierarchicalReadWriteLocker,
    identifierStrategy: IdentifierStrategy,
    authStrategy: AuxiliaryIdentifierStrategy,
    auxiliaryStrategy: AuxiliaryIdentifierStrategy,
    profile: GuardedPolicyProfile = 'acp-ground-v1',
  ) {
    if (!isGuardedProfile(profile)) {
      throw new Error('AgentReadObservation profile must be a supported maintained builtin ground profile');
    }
    this.options = { permissionReader, authorizer, credentialsExtractor, accessor, authorityStore, locks,
      identifierStrategy, authStrategy, auxiliaryStrategy, profile };
  }

  /** The deployed guarded profile this capability is bound to (matches the handler's runtime profile). */
  public get profile(): GuardedPolicyProfile {
    return this.options.profile;
  }

  /**
   * Identity qualification against the handler's ACTUAL dependencies. Class names, authMode strings or
   * private-field reflection are not proof. The `usesAuthorityLocker` check additionally proves the
   * locking store and locker are the same shared pair.
   */
  public qualify(actual: AgentReadObservationActual): void {
    const expected = this.options;
    if (!expected.authorityStore.usesAuthorityLocker(expected.locks)
      || actual.permissionReader !== expected.permissionReader
      || actual.authorizer !== expected.authorizer
      || actual.credentialsExtractor !== expected.credentialsExtractor
      || !actual.accessor
      || actual.accessor !== expected.accessor
      || actual.authorityStore !== expected.authorityStore
      || actual.locks !== expected.locks
      || !actual.authorityStore
      || actual.authorityStore.usesAuthorityLocker(actual.locks as ExpiringReadWriteLocker) !== true
      || actual.identifierStrategy !== expected.identifierStrategy
      || actual.authStrategy !== expected.authStrategy
      || actual.auxiliaryStrategy !== expected.auxiliaryStrategy
      || !actual.podLookup) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation capability does not match the actual authorization assembly');
    }
  }

  /** Parse, qualify, and run the bounded A1 ACP observation; returns the closed response payload string. */
  public async handle(request: HttpRequest, sidecar: AgentReadObservationSidecar, body: string, actual: AgentReadObservationActual): Promise<string> {
    // The public A1 observation wire stays ACP-only. A WAC capability refuses the media 415; WAC
    // profile qualification is reachable only through the separate A2N declaration route.
    if (this.options.profile !== 'acp-ground-v1') {
      throw new UnsupportedMediaTypeHttpError('Authorization observation requires the ACP guarded profile');
    }
    let parsed;
    try {
      parsed = parseAuthorizationObservationRequest(JSON.parse(body));
    } catch {
      throw new BadRequestHttpError('Malformed authorization observation request');
    }
    const prepared = await this.prepare(request, sidecar, parsed.sourceIri, actual);
    const response = await this.runBounded(prepared, (audit) =>
      this.evaluate(parsed, prepared.roomScope, prepared.physicalDocument, prepared.requester, prepared.requesterWebId, prepared.podLookup, audit));
    return serializeAuthorizationObservationResponse(response);
  }

  /** Parse, qualify, and run the closed A2N profile negotiation; returns the declaration payload string. */
  public async negotiate(request: HttpRequest, sidecar: AgentReadObservationSidecar, body: string, actual: AgentReadObservationActual): Promise<string> {
    let parsed: AuthorizationProfileNegotiationRequest;
    try {
      parsed = parseAuthorizationProfileNegotiationRequest(JSON.parse(body));
    } catch {
      throw new BadRequestHttpError('Malformed authorization profile negotiation request');
    }
    const prepared = await this.prepare(request, sidecar, parsed.sourceIri, actual);
    const declaration = await this.runBounded(prepared, (audit) =>
      this.negotiateEvaluate(parsed, prepared.roomScope, prepared.physicalDocument, prepared.requester, prepared.requesterWebId, prepared.podLookup, audit));
    return serializeAuthorizationProfileDeclaration(declaration);
  }

  /** Shared qualify + container + source-scope + requester authentication before any collection. */
  private async prepare(request: HttpRequest, sidecar: AgentReadObservationSidecar, sourceIri: string, actual: AgentReadObservationActual): Promise<{
    roomScope: string; physicalDocument: string; requester: Credentials; requesterWebId: string; podLookup: PodLookupRepository;
  }> {
    this.qualify(actual);
    if (!sidecar.isContainer) throw new UnsupportedMediaTypeHttpError('Authorization observation requires a room container sidecar');
    const roomScope = sidecar.baseUrl;
    const physicalDocument = physicalDocumentIriOf(sourceIri);
    const strategy = this.options.identifierStrategy;
    if (!strategy.supportsIdentifier({ path: physicalDocument })
      || !strategy.contains({ path: roomScope }, { path: physicalDocument }, true)
      || this.options.auxiliaryStrategy.isAuxiliaryIdentifier({ path: physicalDocument })) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation source is outside the room scope');
    }
    const requester = await this.options.credentialsExtractor.handleSafe(request);
    const requesterWebId = requester.agent?.webId;
    if (!requesterWebId) throw new ForbiddenHttpError('Authorization observation requires an authenticated WebID');
    return { roomScope, physicalDocument, requester, requesterWebId, podLookup: actual.podLookup! };
  }

  /**
   * ONE shared bounded collection lifecycle for A1 observation and A2N negotiation: a dependency
   * discovery pass, then exactly one fresh pass under the exclusive room WRITE scope plus external
   * policy read dependencies, with the same retry-on-authority-change contract. An actual LDP PUT
   * newly creating a descendant holds only child WRITE + ancestor READ, so a room READ could not
   * exclude it; the room WRITE does. Internal reads are covered by this plan, so the locking store
   * reuses the held locks instead of re-acquiring.
   */
  private async runBounded<T>(
    prepared: { roomScope: string; physicalDocument: string; requester: Credentials; requesterWebId: string; podLookup: PodLookupRepository },
    collect: (audit: ObservationDispatchAudit) => Promise<T>,
  ): Promise<T> {
    const { roomScope } = prepared;
    const additional = new Set<string>();
    for (let attempt = 0; ; attempt += 1) {
      try {
        const discoveryState = newAuthoritySnapshotState();
        await this.runAttempt(discoveryState, collect);
        const dependencies = [ ...new Set([
          ...additional,
          ...[ ...discoveryState.dependencies.values() ].map(dependency => dependency.lockUri),
        ]) ].map(path => ({ path }) as ResourceIdentifier);

        let result: T | undefined;
        const freshState = newAuthoritySnapshotState(uri => this.options.locks.hasHeldReadLock({ path: uri }));
        await this.options.locks.withWriteLockAndReadDependencies({ path: roomScope }, dependencies, async() => {
          result = await this.runAttempt(freshState, collect);
          if (!authorityDependenciesFresh(freshState)) throw new StaleObservationError('Authority changed during observation');
        });
        return result!;
      } catch (error) {
        if (error instanceof AuthorityDependencyRetryError) {
          for (const uri of error.lockUris) additional.add(uri);
        }
        const retriable = error instanceof AuthorityDependencyRetryError || error instanceof StaleObservationError;
        if (retriable && attempt < MAX_ATTEMPTS - 1) {
          continue;
        }
        if (retriable) throw new ConflictHttpError('Authorization observation state changed; retry the request');
        throw error;
      }
    }
  }

  private async runAttempt<T>(
    state: AuthoritySnapshotState,
    collect: (audit: ObservationDispatchAudit) => Promise<T>,
  ): Promise<T> {
    const audit: ObservationDispatchAudit = { covered: new Set<string>(), targetCovered: new Set<string>(), phase: 'requester', stickyFailure: false };
    try {
      return await metadataRequestContext.run({ metadataCache: new Map() }, () =>
        observationDispatchContext.run(audit, () =>
          collectAuthorityDependencies(state, () => collect(audit))));
    } finally {
      // Wait for real stream teardown as well as permission-reader completion before the lock leaves.
      await settleAuthorityReads(state);
    }
  }

  /**
   * The single internal collection path. Builds the guarded closure with the capability's bound
   * profile, enforces requester admission (room Control + source Read), enumerates the actual
   * ordinary inventory under the caller's lock/audit context, independently re-reads the complete
   * physical source and verifies the caller's expected ground-source digest, then requires requester
   * Read for every returned ordinary resource. A fresh agent-only hypothetical target Read is ALSO
   * evaluated/audited for EVERY returned ordinary resource through the SAME bound default dispatch
   * (A1 publishes the rows; A2N qualification discards them). A normal authorizer denial stays a valid
   * denial; a reader/engine/internal error or a bypassed/unknown default dispatch fails the whole
   * collection. The target audit must never ride requester coverage.
   */
  private async collectGuard(
    parsed: { sourceIri: string; expectedSourceDigest: string; targetWebId: string },
    roomScope: string,
    physicalDocument: string,
    requester: Credentials,
    podLookup: PodLookupRepository,
    audit: ObservationDispatchAudit,
  ): Promise<{ guard: GuardedPolicySnapshot; sourceDigest: string; read: AuthorizationObservationReadRow[] }> {
    const closure = new GuardedPolicyClosure({
      accessor: this.options.accessor,
      store: this.options.authorityStore,
      locks: this.options.locks,
      identifierStrategy: this.options.identifierStrategy,
      authStrategy: this.options.authStrategy,
      auxiliaryStrategy: this.options.auxiliaryStrategy,
      podLookup,
      profile: this.options.profile,
      beforeEnumerate: async(containerIri) => {
        await this.requireAccess(requester, { path: containerIri }, [ PERMISSIONS.Read ], audit);
      },
    });

    // Requester admission: room Control and source Read are mandatory actual admission facts.
    await this.requireAccess(requester, { path: roomScope }, [ ACL.Control ], audit);
    await this.requireAccess(requester, { path: physicalDocument }, [ PERMISSIONS.Read ], audit);

    const guard = await closure.read(roomScope);
    if (!guard.resources.some(resource => resource.iri === physicalDocument)) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation source is not in the actual room inventory');
    }

    const sourceQuads = await this.readGroundQuads(physicalDocument);
    const sourceDigest = digestGroundSource(parsed.sourceIri, physicalDocument, sourceQuads);
    if (sourceDigest !== parsed.expectedSourceDigest) {
      throw new ConflictHttpError('Authorization observation source digest does not match the current ground source');
    }

    const read: AuthorizationObservationReadRow[] = [];
    for (const resource of guard.resources) {
      // Every returned ordinary resource must be requester-readable; a hidden denial fails the whole
      // observation rather than being filtered out. Each call is individually qualified inside
      // requireAccess/evaluateTargetRead, so a later bypass can never ride an earlier traversal.
      await this.requireAccess(requester, { path: resource.iri }, [ PERMISSIONS.Read ], audit);
      // Audit a fresh agent-only hypothetical target Read on the SAME default dispatch. A denied
      // target is a valid `false` (still a qualified profile); an unsupported/unknown/bypassed
      // dispatch throws 415 and a reader/engine fault throws 500, so a custom outer reader that
      // forwards only the target to a different identity can never certify the WAC local proof path.
      const allowed = await this.evaluateTargetRead(parsed.targetWebId, { path: resource.iri }, audit);
      read.push({ iri: resource.iri, allowed });
    }

    // Defense in depth: stickyFailure is never cleared across calls, so an unsupported route swallowed
    // by a fallback in any call still fails the whole observation.
    if (audit.stickyFailure) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation dispatch did not traverse the bound default reader');
    }
    return { guard, sourceDigest, read };
  }

  private async evaluate(
    parsed: ReturnType<typeof parseAuthorizationObservationRequest>,
    roomScope: string,
    physicalDocument: string,
    requester: Credentials,
    requesterWebId: string,
    podLookup: PodLookupRepository,
    audit: ObservationDispatchAudit,
  ): Promise<AuthorizationObservationResponse> {
    const { guard, sourceDigest, read } = await this.collectGuard(parsed, roomScope, physicalDocument, requester, podLookup, audit);
    return {
      version: 1,
      profile: AUTHORIZATION_OBSERVATION_PROFILE,
      requesterWebId,
      targetWebId: parsed.targetWebId,
      sourceIri: parsed.sourceIri,
      sourceDigest,
      contextDigest: parsed.contextDigest,
      challenge: parsed.challenge,
      guard,
      read,
    };
  }

  /**
   * Qualification only: the same collection path (including the per-resource target dispatch audit),
   * but the declaration publishes only the actual profile and echoed identities — never read rows.
   */
  private async negotiateEvaluate(
    parsed: AuthorizationProfileNegotiationRequest,
    roomScope: string,
    physicalDocument: string,
    requester: Credentials,
    requesterWebId: string,
    podLookup: PodLookupRepository,
    audit: ObservationDispatchAudit,
  ): Promise<AuthorizationProfileDeclaration> {
    const { sourceDigest } = await this.collectGuard(parsed, roomScope, physicalDocument, requester, podLookup, audit);
    return {
      version: 1,
      profile: AUTHORIZATION_PROFILE_DECLARATION_PROFILE,
      guardedPolicyProfile: this.options.profile,
      requesterWebId,
      targetWebId: parsed.targetWebId,
      sourceIri: parsed.sourceIri,
      sourceDigest,
      contextDigest: parsed.contextDigest,
      challenge: parsed.challenge,
    };
  }

  /**
   * Runs exactly ONE actual permission-reader call under a fresh call-specific audit scope and verifies
   * IMMEDIATELY, before the authorizer/enumeration/next call, that this call's requested identifier was
   * dispatched through the bound default route. Requester and target share the scoped audit mechanism
   * but never each other's per-call coverage; `stickyFailure` is never cleared across calls.
   */
  private async verifyReaderCall(
    credentials: Credentials,
    requestedModes: IdentifierSetMultiMap<string>,
    identifier: ResourceIdentifier,
    phase: 'requester' | 'target',
    audit: ObservationDispatchAudit,
  ) {
    audit.phase = phase;
    audit.covered.clear();
    audit.targetCovered.clear();
    const availablePermissions = await this.options.permissionReader.handleSafe({ credentials, requestedModes });
    const covered = phase === 'target' ? audit.targetCovered : audit.covered;
    if (audit.stickyFailure || !covered.has(identifier.path)) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation dispatch did not qualify this permission call');
    }
    return availablePermissions;
  }

  /** Actual requester admission through the SAME reader/authorizer; any failure is a hard refusal. */
  private async requireAccess(credentials: Credentials, identifier: ResourceIdentifier, modes: string[], audit: ObservationDispatchAudit): Promise<void> {
    const requestedModes = new IdentifierSetMultiMap<string>();
    for (const mode of modes) requestedModes.add(identifier, mode);
    const availablePermissions = await this.verifyReaderCall(credentials, requestedModes, identifier, 'requester', audit);
    await this.options.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
  }

  /**
   * Hypothetical target evaluation: a freshly built agent-only credential, never the requester's
   * client/issuer and never a claimed target DPoP. Only an actual builtin normal Read refusal
   * ({@link ForbiddenHttpError}) AFTER a successful call-qualified reader is `false`; a reader, transport
   * or authorizer fault is an explicit unknown failure that fails the whole observation, never `false`.
   */
  private async evaluateTargetRead(targetWebId: string, identifier: ResourceIdentifier, audit: ObservationDispatchAudit): Promise<boolean> {
    const credentials: Credentials = { agent: { webId: targetWebId } };
    const requestedModes = new IdentifierSetMultiMap<string>();
    requestedModes.add(identifier, PERMISSIONS.Read);
    let availablePermissions;
    try {
      availablePermissions = await this.verifyReaderCall(credentials, requestedModes, identifier, 'target', audit);
    } catch (error) {
      if (error instanceof AuthorityDependencyRetryError || error instanceof UnsupportedMediaTypeHttpError) throw error;
      throw new InternalServerError('Authorization observation target reader failed');
    }
    try {
      await this.options.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
      return true;
    } catch (error) {
      if (error instanceof AuthorityDependencyRetryError) throw error;
      if (error instanceof ForbiddenHttpError) return false;
      throw error;
    }
  }

  /** Bounded, fully drained ground quad read of the physical source document. */
  private async readGroundQuads(documentIri: string): Promise<Quad[]> {
    let representation;
    try {
      representation = await this.options.authorityStore.getRepresentation({ path: documentIri }, { type: { [INTERNAL_QUADS]: 1 } });
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) throw new ConflictHttpError('Authorization observation source document is missing');
      throw error;
    }
    const quads: Quad[] = [];
    let bytes = 0;
    try {
      for await (const value of representation.data) {
        const quad = value as Quad;
        if (!quad || !quad.subject || !quad.predicate || !quad.object || !quad.graph) {
          throw new BadRequestHttpError('Authorization observation source is not ground RDF');
        }
        let quadBytes: number;
        try { quadBytes = groundPolicyQuadBytes(quad); }
        catch { throw new BadRequestHttpError('Authorization observation source is not supported ground RDF'); }
        bytes += quadBytes;
        quads.push(quad);
        if (quads.length > MAX_SOURCE_QUADS || bytes > MAX_SOURCE_BYTES) {
          throw new BadRequestHttpError('Authorization observation source exceeds its bounded budget');
        }
      }
    } finally {
      if (!representation.data.readableEnded && !representation.data.destroyed) representation.data.destroy();
    }
    return quads;
  }
}
