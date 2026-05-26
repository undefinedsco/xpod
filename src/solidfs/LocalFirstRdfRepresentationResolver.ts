import {
  BasicRepresentation,
  NotFoundHttpError,
  type AuxiliaryStrategy,
  type Representation,
  type ResourceIdentifier,
} from '@solid/community-server';

import type { LocalRdfReadableAccessor } from '../storage/accessors/MixDataAccessor';

export interface LocalFirstRdfRepresentationResolverOptions {
  accessor: unknown;
  metadataStrategy: Pick<AuxiliaryStrategy, 'isAuxiliaryIdentifier'>;
}

export interface LocalFirstRdfRepresentationResolverLike {
  resolve(identifier: ResourceIdentifier): Promise<Representation | undefined>;
}

/**
 * Resolves user-facing RDF GETs from the local `.ttl` / `.jsonld` file mirror.
 *
 * DataAccessor.getData() keeps CSS' internal `internal/quads` contract; this
 * resolver is the explicit SolidFS content path for local-first HTTP reads.
 */
export class LocalFirstRdfRepresentationResolver implements LocalFirstRdfRepresentationResolverLike {
  private readonly accessor: unknown;
  private readonly metadataStrategy: Pick<AuxiliaryStrategy, 'isAuxiliaryIdentifier'>;

  public constructor(options: LocalFirstRdfRepresentationResolverOptions) {
    this.accessor = options.accessor;
    this.metadataStrategy = options.metadataStrategy;
  }

  public async resolve(identifier: ResourceIdentifier): Promise<Representation | undefined> {
    if (this.metadataStrategy.isAuxiliaryIdentifier(identifier) || !this.isLocalRdfReadable(this.accessor)) {
      return undefined;
    }

    try {
      const document = await this.accessor.getLocalRdfDocument(identifier);
      return new BasicRepresentation(document.data, document.metadata);
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private isLocalRdfReadable(accessor: unknown): accessor is LocalRdfReadableAccessor {
    return typeof accessor === 'object' &&
      accessor !== null &&
      typeof (accessor as { getLocalRdfDocument?: unknown }).getLocalRdfDocument === 'function';
  }
}
