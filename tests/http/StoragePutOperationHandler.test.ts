import { BasicRepresentation, HH, type AuxiliaryStrategy, type ChangeMap, type OperationHandlerInput, type Representation, type ResourceStore } from '@solid/community-server';
import { expect, it } from 'vitest';
import { StoragePutOperationHandler } from '../../src/http/StoragePutOperationHandler';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';
import { captureStorageVersion, stampStorageVersion } from '../../src/storage/StorageVersion';

const target = { path: 'https://candidate.example/pod/file.txt' };
const etags = new StorageETagHandler();
const auxiliary = { isAuxiliaryIdentifier: () => false } as unknown as AuxiliaryStrategy;
const input = (body: Representation): OperationHandlerInput => ({ operation: { method: 'PUT', target, body, preferences: {} } });

it('returns its own persisted version when another request writes before the first response finishes', async () => {
  let entered!: () => void;
  let resume!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const firstResume = new Promise<void>((resolve) => { resume = resolve; });
  let writes = 0;
  const source = {
    hasResource: async () => false,
    setRepresentation: async (_id: unknown, body: Representation) => {
      stampStorageVersion(body.metadata);
      captureStorageVersion(body.metadata);
      if (++writes === 1) { entered(); await firstResume; }
      return new Map() as ChangeMap;
    },
    getRepresentation: () => { throw new Error('A later read cannot supply a mutation receipt'); },
  } as unknown as ResourceStore;
  const handler = new StoragePutOperationHandler(source, auxiliary, etags);
  const firstBody = new BasicRepresentation('first', target, 'text/plain');
  const secondBody = new BasicRepresentation('second', target, 'text/plain');
  const first = handler.handle(input(firstBody));
  await firstEntered;
  const firstVersion = etags.getETag(firstBody.metadata);
  const second = await handler.handle(input(secondBody));
  resume();
  expect((await first).metadata!.get(HH.terms.etag)!.value).toBe(firstVersion);
  expect(second.metadata!.get(HH.terms.etag)!.value).toBe(etags.getETag(secondBody.metadata));
  expect(second.metadata!.get(HH.terms.etag)!.value).not.toBe(firstVersion);
});

it('does not emit a validator for transformed RDF without a persisted representation content type', async () => {
  const source = {
    hasResource: async () => false,
    setRepresentation: async (_id: unknown, body: Representation) => {
      body.metadata.contentType = undefined;
      stampStorageVersion(body.metadata);
      captureStorageVersion(body.metadata);
      return new Map() as ChangeMap;
    },
  } as unknown as ResourceStore;
  const response = await new StoragePutOperationHandler(source, auxiliary, etags)
    .handle(input(new BasicRepresentation('<#a> <#b> <#c>.', target, 'text/turtle')));
  expect(response.statusCode).toBe(201);
  expect(response.metadata?.get(HH.terms.etag)).toBeUndefined();
});
