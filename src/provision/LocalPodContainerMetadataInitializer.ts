import { randomUUID } from 'node:crypto';
import {
  DataAccessor, Initializer, LDP, RDF, NotFoundHttpError, RepresentationMetadata,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { PodDeletionOperationRepository } from '../identity/drizzle/PodDeletionOperationRepository';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { getIdentityDatabase } from '../identity/drizzle/db';

/** Repairs legacy bootstrap metadata before CSS workers accept resource mutations. */
export class LocalPodContainerMetadataInitializer extends Initializer {
  private readonly pods: PodLookupRepository;
  private readonly operations: PodDeletionOperationRepository;
  private readonly root: URL;
  private readonly logger = getLoggerFor(this);

  public constructor(
    private readonly dataAccessor: DataAccessor,
    identityDbUrl: string,
    baseUrl: string,
  ) {
    super();
    this.pods = new PodLookupRepository(getIdentityDatabase(identityDbUrl));
    this.operations = new PodDeletionOperationRepository(identityDbUrl);
    this.root = new URL(baseUrl.replace(/\/?$/u, '/'));
  }

  public override async handle(): Promise<void> {
    for (const pod of await this.pods.listAllPods()) {
      const storageUrl = pod.storageUrl ?? pod.baseUrl;
      const url = new URL(storageUrl);
      if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname)
        || url.href === this.root.href || !url.pathname.endsWith('/') || url.search || url.hash) continue;

      const reservation = randomUUID();
      // API provisioning/deletion can run while CSS initializes. Never race their storage incarnation.
      await this.operations.reserveStorage(storageUrl, reservation, 'repair');
      try {
        const current = await this.pods.findById(pod.podId);
        if (!current || current.accountId !== pod.accountId
          || (current.storageUrl ?? current.baseUrl) !== storageUrl
          || await this.operations.blocksMutation(storageUrl)) continue;
        const identifier = { path: storageUrl };
        let metadata: RepresentationMetadata;
        try { metadata = await this.dataAccessor.getMetadata(identifier); }
        catch (error) { if (NotFoundHttpError.isInstance(error)) continue; throw error; }
        if (!metadata.getAll(RDF.terms.type).some(term => term.equals(LDP.terms.Container))) continue;

        const settings = new URL('settings/', storageUrl).href;
        let advertised = false;
        for await (const child of this.dataAccessor.getChildren(identifier)) {
          if (child.identifier.value === settings) { advertised = true; break; }
        }
        if (!advertised) continue;
        try { await this.dataAccessor.getMetadata({ path: settings }); }
        catch (error) {
          if (!NotFoundHttpError.isInstance(error)) throw error;
          // Operational CSS metadata is outside business schemas. Use its accessor contract,
          // preserving the Pod's authority/containment and all original resource files.
          await this.dataAccessor.writeContainer({ path: settings }, new RepresentationMetadata({ path: settings }));
          this.logger.info('Restored missing registered Local Pod settings container metadata.');
        }
      } finally { await this.operations.releaseStorage(storageUrl, reservation); }
    }
  }
}
