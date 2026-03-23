import { linxSchema } from '@undefineds.co/models';

export const VectorStore = linxSchema.vectorStoreTable as any;

export type VectorStoreRow = typeof VectorStore.$inferSelect;
export type VectorStoreInsert = typeof VectorStore.$inferInsert;

export const IndexedFile = linxSchema.indexedFileTable as any;

export type IndexedFileRow = typeof IndexedFile.$inferSelect;
export type IndexedFileInsert = typeof IndexedFile.$inferInsert;
