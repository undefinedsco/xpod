import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { getIdentityDatabase } from '../identity/drizzle/db';
import type { RdfTextSourceInput } from '../storage/rdf';
import { RdfSearchReconciliationRepository } from './RdfSearchReconciliationRepository';

/**
 * Narrow CSS-side durable intent sink for text-index commits.
 *
 * The sink records only Pod/source/profile coordination state in the identity
 * database. It does not persist provider API keys, access tokens, or client
 * secrets. Pod ownership is resolved through the canonical Pod lookup table and
 * fails closed when a source cannot be mapped to a known Pod root.
 */
export class RdfSearchReconciliationIntentSink {
  private readonly repository: RdfSearchReconciliationRepository;
  private readonly podLookupRepository: PodLookupRepository;

  public constructor(identityDbUrl: string) {
    const db = getIdentityDatabase(identityDbUrl);
    this.repository = new RdfSearchReconciliationRepository(db);
    this.podLookupRepository = new PodLookupRepository(db);
  }

  public async recordTextCommitted(source: RdfTextSourceInput): Promise<void> {
    const sourceKey = source.sourceKey ?? source.source;
    const pod = await this.podLookupRepository.findByResourceIdentifier(source.source);
    if (!pod) {
      throw new Error(`Unable to record RDF search indexing intent for unknown Pod source ${source.source}`);
    }
    const podRoot = pod.storageUrl ?? pod.baseUrl;
    if (!podRoot) {
      throw new Error(`Unable to record RDF search indexing intent without Pod root for source ${source.source}`);
    }

    await this.repository.waitForConfig({
      sourceKey,
      sourceUri: source.source,
      podRoot,
      sourceHash: source.sourceHash,
      sourceVersion: source.sourceVersion,
      reason: 'text-source-committed',
    });
  }

  public async recordSourceDeleted(sourceKey: string): Promise<void> {
    await this.repository.deleteSource(sourceKey);
  }
}
