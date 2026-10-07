import { INTERNAL_QUADS, LDP, RDF, isContainerIdentifier, NotFoundHttpError, UnsupportedMediaTypeHttpError } from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, IdentifierStrategy } from '@solid/community-server';
import type { Quad } from '@rdfjs/types';
import type { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import type { MixDataAccessor } from './accessors/MixDataAccessor';
import type { LockingResourceStore } from './LockingResourceStore';
import type { HierarchicalReadWriteLocker } from './HierarchicalReadWriteLocker';
import { captureAuthorityDependency } from './AuthoritySnapshotContext';
import { digestGroundPolicy, groundPolicyQuadBytes, assertGroundWacPolicy, assertGroundAcpPolicy, guardedPolicyIri,
  type GuardedPolicySnapshot, type GuardedPolicyEntry, type GuardedPolicyProfile, type GuardedPolicyKind } from './rdf/GuardedPolicySnapshot';

export interface GuardedPolicyClosureOptions {
  accessor: MixDataAccessor; store: LockingResourceStore; locks: HierarchicalReadWriteLocker;
  identifierStrategy: IdentifierStrategy; authStrategy: AuxiliaryIdentifierStrategy;
  auxiliaryStrategy: AuxiliaryIdentifierStrategy;   podLookup: PodLookupRepository;
  /** Deployed guarded profile; must match the actual authMode-derived configuration. */
  profile?: GuardedPolicyProfile;
  /**
   * Observer-only admission hook, invoked immediately before every `getChildren`. The server binds it
   * to actual requester Read admission so no child is enumerated for a requester without access. It
   * grants no transport access and mints no proof; leaving it unset keeps the ordinary closure.
   */
  beforeEnumerate?: (containerIri: string) => Promise<void>;
}
/** Server-owned topology and policy evidence, never an effective-Read evaluator. */
export class GuardedPolicyClosure {
  public constructor(private readonly options: GuardedPolicyClosureOptions) {}

  public async read(scopeInput: string): Promise<GuardedPolicySnapshot> {
    const scope = guardedPolicyIri(scopeInput);
    const profile = this.options.profile ?? 'wac-ground-v1';
    const kind: GuardedPolicyKind = profile === 'acp-ground-v1' ? 'acp' : 'wac';
    const { accessor, store, locks, identifierStrategy: strategy, authStrategy, auxiliaryStrategy, podLookup } = this.options;
    if (!store.usesAuthorityLocker(locks)) throw new UnsupportedMediaTypeHttpError('Guarded policy closure requires the actual shared locking store');
    const pod = await podLookup.findByResourceIdentifier(scope);
    if (!pod) throw new UnsupportedMediaTypeHttpError('Guarded policy closure requires a registered Pod');
    const roots = [pod.baseUrl, pod.storageUrl].filter((value): value is string => Boolean(value))
      .filter(root => scope.startsWith(root)).sort((a, b) => b.length - a.length);
    if (!roots.length) throw new UnsupportedMediaTypeHttpError('Unregistered guarded scope');
    const root = guardedPolicyIri(roots[0]);
    if (!root.endsWith('/')) throw new UnsupportedMediaTypeHttpError('Registered Pod root is not a container');
    const supported = (iri: string): string => {
      guardedPolicyIri(iri);
      if (!iri.startsWith(root) || !strategy.supportsIdentifier({ path: iri })) throw new UnsupportedMediaTypeHttpError('Foreign guarded resource');
      return iri;
    };
    const parent = (iri: string): string => {
      if (iri === root) throw new UnsupportedMediaTypeHttpError('WAC policy inheritance outside registered Pod is unsupported');
      const result = supported(strategy.getParentContainer({ path: iri }).path);
      if (result === iri || !strategy.contains({ path: result }, { path: iri }, false)) throw new UnsupportedMediaTypeHttpError('Unproved guarded ancestry');
      return result;
    };
    // ACP inherits through the ACTUAL server ancestry (root ACR included) using the installed
    // IdentifierStrategy root semantics; never origin/pod/path depth or an arbitrary getParent error.
    // A separate internal authority scope keeps read-only ancestors reachable beyond the Pod while
    // the room inventory / writable graphs / nativeBase stay within the registered Pod.
    const acpParent = (iri: string): string => {
      if (strategy.isRootContainer({ path: iri })) throw new UnsupportedMediaTypeHttpError('ACP policy inheritance beyond server root is unsupported');
      const result = guardedPolicyIri(strategy.getParentContainer({ path: iri }).path);
      if (!strategy.supportsIdentifier({ path: result }) || !strategy.contains({ path: result }, { path: iri }, false)) {
        throw new UnsupportedMediaTypeHttpError('Unproved ACP ancestry');
      }
      return result;
    };
    const policyFor = (iri: string, authority = false): string => authority
      ? guardedPolicyIri(authStrategy.getAuxiliaryIdentifier({ path: iri }).path)
      : supported(authStrategy.getAuxiliaryIdentifier({ path: iri }).path);
    /** The actual resource an ACR document is associated with, via the installed authStrategy. */
    const associatedResource = (acrIri: string): string => {
      try { return guardedPolicyIri(authStrategy.getSubjectIdentifier({ path: acrIri }).path); }
      catch { throw new UnsupportedMediaTypeHttpError('ACP ACR has no actual resource association'); }
    };
    const metadata = async(iri: string, requireContainer = false) => {
      captureAuthorityDependency(iri, store.getLockIdentifier({ path: iri }).path);
      const meta = await accessor.getMetadata({ path: iri });
      const container = meta.has(RDF.terms.type, LDP.terms.Container) || meta.has(RDF.terms.type, LDP.terms.BasicContainer);
      if (container !== isContainerIdentifier({ path: iri }) || (requireContainer && !container)) {
        throw new UnsupportedMediaTypeHttpError('Resource container metadata disagrees with the actual CSS identifier semantics');
      }
      return meta;
    };
    let totalBytes = 0;
    let totalQuads = 0;
    const policies = new Map<string, GuardedPolicyEntry>();
    const ancestors = new Map<string, { iri: string; policyIri: string }>();
    const policy = async(iri: string): Promise<GuardedPolicyEntry> => {
      const cached = policies.get(iri);
      if (cached) return cached;
      if (policies.size >= 512) throw new UnsupportedMediaTypeHttpError('Guarded policy budget exceeded');
      captureAuthorityDependency(iri, store.getLockIdentifier({ path: iri }).path);
      let result: GuardedPolicyEntry;
      try {
        const representation = await store.getRepresentation({ path: iri }, { type: { [INTERNAL_QUADS]: 1 } });
        const quads: Quad[] = [];
        let bytes = 0;
        try {
          for await (const value of representation.data) {
            const quad = value as Quad;
            if (!quad || !quad.subject || !quad.predicate || !quad.object || !quad.graph) throw new Error('Policy representation is not RDF');
            let quadBytes: number;
            try { quadBytes = groundPolicyQuadBytes(quad); }
            catch { throw new UnsupportedMediaTypeHttpError('Only ground WAC RDF is supported'); }
            bytes += quadBytes; totalBytes += quadBytes; totalQuads += 1;
            if (totalBytes > 8 * 1024 * 1024 || totalQuads > 100000) throw new UnsupportedMediaTypeHttpError('Guarded closure total body budget exceeded');
            if (quads.length >= 100000 || bytes > 8 * 1024 * 1024) throw new Error('Guarded policy body budget exceeded');
            quads.push(quad);
          }
          // Decode the complete bounded stream before rejecting an unsupported policy shape.
          // A deliberate early close must never masquerade as a completed authority read.
          try {
            if (kind === 'acp') assertGroundAcpPolicy(iri, associatedResource(iri), quads);
            else assertGroundWacPolicy(quads);
          } catch (error) { throw new UnsupportedMediaTypeHttpError(error instanceof Error ? error.message : 'Unsupported ground policy'); }
          let digest: string;
          try { digest = digestGroundPolicy(iri, kind, quads); }
          catch { throw new UnsupportedMediaTypeHttpError('Only ground policy RDF is supported'); }
          result = { iri, kind, state: quads.length ? 'present' : 'present-empty', digest };
        } finally {
          if (!representation.data.readableEnded && !representation.data.destroyed) representation.data.destroy();
        }
      } catch (error) {
        if (!NotFoundHttpError.isInstance(error)) throw error;
        result = { iri, kind, state: 'absent404', digest: null };
      }
      policies.set(iri, result);
      return result;
    };
    const resources: GuardedPolicySnapshot['resources'] = [];
    const visited = new Set<string>();
    const visit = async(iri: string, depth: number): Promise<void> => {
      supported(iri);
      if (visited.has(iri) || depth > 32 || visited.size >= 256) throw new UnsupportedMediaTypeHttpError('Guarded resource inventory is cyclic or exceeds budget');
      visited.add(iri);
      const meta = await metadata(iri, iri === scope);
      const container = meta.has(RDF.terms.type, LDP.terms.Container) || meta.has(RDF.terms.type, LDP.terms.BasicContainer);
      const children: string[] = [];
      if (container) {
        await this.options.beforeEnumerate?.(iri);
        const all = new Set<string>();
        for await (const child of accessor.getChildren({ path: iri })) {
          const path = supported(child.identifier.value);
          if (!strategy.contains({ path: iri }, { path }, false)) throw new UnsupportedMediaTypeHttpError('Non-direct guarded child');
          if (all.has(path)) continue;
          all.add(path);
          if (all.size > 512) throw new UnsupportedMediaTypeHttpError('Guarded child budget exceeded');
          if (!auxiliaryStrategy.isAuxiliaryIdentifier({ path })) children.push(path);
        }
      }
      const policyIri = policyFor(iri);
      resources.push({ iri, container, children: children.sort(), policyIri });
      if (kind === 'wac') {
        let current = iri;
        let currentPolicy = await policy(policyIri);
        let inheritanceDepth = 0;
        // WAC: only an actual404 continues; a present (including present-empty) stops inheritance.
        while (currentPolicy.state === 'absent404') {
          if (++inheritanceDepth > 32) throw new UnsupportedMediaTypeHttpError('Guarded inheritance budget exceeded');
          current = parent(current);
          await metadata(current, true);
          const ancestorPolicy = policyFor(current);
          if (!strategy.contains({ path: scope }, { path: current }, true) && current !== scope) ancestors.set(current, { iri: current, policyIri: ancestorPolicy });
          currentPolicy = await policy(ancestorPolicy);
        }
      } else {
        // ACP: the resource's own ACR is captured as a normal policy entry (above). Then every
        // actual parent through the server root is a read-only ancestor dependency: both a missing
        // and a present-empty ACR continue inheritance, and ancestors need not have materialized
        // metadata. Only ancestors OUTSIDE the enumerated room scope go into `ancestors`.
        await policy(policyIri);
        let current = iri;
        let inheritanceDepth = 0;
        while (!strategy.isRootContainer({ path: current })) {
          if (++inheritanceDepth > 32) throw new UnsupportedMediaTypeHttpError('ACP inheritance budget exceeded');
          current = acpParent(current);
          const ancestorPolicy = policyFor(current, true);
          await policy(ancestorPolicy);
          if (!strategy.contains({ path: scope }, { path: current }, true) && current !== scope) {
            ancestors.set(current, { iri: current, policyIri: ancestorPolicy });
          }
        }
      }
      for (const child of children) await visit(child, depth + 1);
    };
    await visit(scope, 0);
    if (!resources[0].container) throw new UnsupportedMediaTypeHttpError('Guarded scope must be a room container');
    return { profile, scope, resources,
      ancestors: [...ancestors.values()], policies: [...policies.values()] };
  }
}
