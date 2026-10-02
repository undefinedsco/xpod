import {
  HH, PutOperationHandler, RepresentationMetadata,
  type AuxiliaryStrategy, type ETagHandler, type OperationHandlerInput,
  type ResourceStore, type ResponseDescription,
} from '@solid/community-server';
import { DataFactory } from 'n3';
import { storageVersionReceipts } from '../storage/StorageVersion';

/** Preserves CSS PUT handling and returns this mutation's receipt, never a later HEAD. */
export class StoragePutOperationHandler extends PutOperationHandler {
  public constructor(store: ResourceStore, metadataStrategy: AuxiliaryStrategy, private readonly eTagHandler: ETagHandler) {
    super(store, metadataStrategy);
  }

  public override async handle(input: OperationHandlerInput): Promise<ResponseDescription> {
    return storageVersionReceipts.run(new Map(), async () => {
      const response = await super.handle(input);
      const receipt = storageVersionReceipts.getStore()!.get(input.operation.target.path);
      const etag = receipt && this.eTagHandler.getETag(receipt);
      if (etag) {
        response.metadata ??= new RepresentationMetadata(input.operation.target);
        response.metadata.set(HH.terms.etag, DataFactory.literal(etag));
      }
      return response;
    });
  }
}
