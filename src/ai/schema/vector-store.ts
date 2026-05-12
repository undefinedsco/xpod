import { indexedFileResource, vectorStoreResource } from '@undefineds.co/models';

export const VectorStore = vectorStoreResource as any;

export type VectorStoreRow = typeof VectorStore.$inferSelect;
export type VectorStoreInsert = typeof VectorStore.$inferInsert;

export const IndexedFile = indexedFileResource as any;

export type IndexedFileRow = typeof IndexedFile.$inferSelect;
export type IndexedFileInsert = typeof IndexedFile.$inferInsert;
