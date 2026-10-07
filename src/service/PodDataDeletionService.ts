import { NotFoundHttpError, isContainerIdentifier, LDP } from '@solid/community-server';
import type { AuxiliaryStrategy, ResourceIdentifier } from '@solid/community-server';
import { DataFactory } from 'n3';
import type { QuintStore } from '../storage/quint/types';
import type { MixDataAccessor } from '../storage/accessors/MixDataAccessor';

export interface PodDeletionPlan {
  baseUrl: string;
  /** Exact resource addresses, in postorder, including auxiliary resources. */
  resources: string[];
}

/**
 * Deletes one Pod's data after its caller authenticates and validates ownership.
 * Account registration/binding removal must happen only after this succeeds.
 * The caller must persist the prepared plan before mutation, reuse it after
 * failures, and prevent concurrent writes while a Pod is being removed.
 */
export class PodDataDeletionService {
  public constructor(
    private readonly dataAccessor: MixDataAccessor,
    private readonly auxiliaryStrategy: AuxiliaryStrategy,
    private readonly legacyQuintStore?: QuintStore,
  ) {}

  public async prepare(baseUrl: ResourceIdentifier): Promise<PodDeletionPlan> {
    this.assertWithinPod(baseUrl, baseUrl);
    if (!isContainerIdentifier(baseUrl)) {
      throw new Error('Pod deletion requires a container identifier');
    }
    const identifiers: ResourceIdentifier[] = [];
    await this.snapshot(baseUrl, baseUrl, new Set(), identifiers);
    return { baseUrl: baseUrl.path, resources: identifiers.map((identifier) => identifier.path) };
  }

  public async deletePodData(baseUrl: ResourceIdentifier, plan?: PodDeletionPlan): Promise<void> {
    const prepared = plan ?? await this.prepare(baseUrl);
    this.validatePlan(baseUrl, prepared);
    for (const resource of prepared.resources) {
      const identifier = { path: resource };
      // Mix needs metadata to select the content/mirror accessor. Removing the
      // source index first would remove that metadata and strand local files.
      await this.ignoreNotFound(() => this.dataAccessor.deleteResource(identifier));
      await this.ignoreNotFound(() => this.dataAccessor.deleteLocalRdfIndex(identifier));
    }
    await this.dataAccessor.deletePodRdfGraphs(baseUrl);
    await this.deleteLegacyMirror(baseUrl);
  }

  /** Local provisioning retains a separate quints mirror; metadata may already be gone on retry. */
  private async deleteLegacyMirror(baseUrl: ResourceIdentifier): Promise<void> {
    const store = this.legacyQuintStore;
    if (!store) { return; }
    await store.open();
    try {
      for (const prefix of [baseUrl.path, `meta:${baseUrl.path}`]) {
        while (true) {
          const statements = await store.getByGraphPrefix(prefix, { limit: 1_000 });
          if (statements.length === 0) { break; }
          await store.multiDel(statements);
        }
      }
      const parent = DataFactory.namedNode(new URL('../', baseUrl.path).href);
      await store.del({ graph: parent, subject: parent, predicate: LDP.terms.contains, object: DataFactory.namedNode(baseUrl.path) });
    } finally { await store.close(); }
  }

  private validatePlan(baseUrl: ResourceIdentifier, plan: PodDeletionPlan): void {
    this.assertWithinPod(baseUrl, baseUrl);
    if (!isContainerIdentifier(baseUrl) || plan.baseUrl !== baseUrl.path ||
      !Array.isArray(plan.resources) || plan.resources[plan.resources.length - 1] !== baseUrl.path) {
      throw new Error('Invalid Pod deletion plan root');
    }
    const seen = new Set<string>();
    for (const resource of plan.resources) {
      this.assertWithinPod(baseUrl, { path: resource });
      if (seen.has(resource)) {
        throw new Error('Pod deletion plan must contain unique resources');
      }
      for (let slash = baseUrl.path.length - 1; slash < resource.length; slash = resource.indexOf('/', slash + 1)) {
        if (slash < 0) { break; }
        if (seen.has(resource.slice(0, slash + 1))) {
          throw new Error('Pod deletion plan must contain resources in postorder');
        }
      }
      seen.add(resource);
    }
  }

  private async snapshot(
    root: ResourceIdentifier,
    identifier: ResourceIdentifier,
    visited: Set<string>,
    identifiers: ResourceIdentifier[],
  ): Promise<void> {
    this.assertWithinPod(root, identifier);
    if (visited.has(identifier.path)) { return; }
    visited.add(identifier.path);
    if (isContainerIdentifier(identifier)) {
      await this.ignoreNotFound(async () => {
        for await (const child of this.dataAccessor.getChildren(identifier)) {
          await this.snapshot(root, { path: child.identifier.value }, visited, identifiers);
        }
      });
    }
    if (!this.auxiliaryStrategy.isAuxiliaryIdentifier(identifier)) {
      for (const auxiliary of this.auxiliaryStrategy.getAuxiliaryIdentifiers(identifier)) {
        await this.snapshot(root, auxiliary, visited, identifiers);
      }
    }
    identifiers.push({ path: identifier.path });
  }

  private assertWithinPod(root: ResourceIdentifier, identifier: ResourceIdentifier): void {
    const url = new URL(identifier.path);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.href !== identifier.path || !identifier.path.startsWith(root.path)) {
      throw new Error('Refusing to delete a resource outside the canonical Pod boundary');
    }
  }

  private async ignoreNotFound(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      if (!NotFoundHttpError.isInstance(error)) { throw error; }
    }
  }
}
