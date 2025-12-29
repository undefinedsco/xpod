/**
 * Drizzle schema for QuintStore
 * 
 * Quint = G, S, P, O, V (Graph, Subject, Predicate, Object, Vector)
 * 
 * 6 indexes aligned with quadstore:
 * - SPOG: subject, predicate, object, graph
 * - OGSP: object, graph, subject, predicate
 * - GSPO: graph, subject, predicate, object
 * - SOPG: subject, object, predicate, graph
 * - POGS: predicate, object, graph, subject
 * - GPOS: graph, predicate, object, subject
 */

import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

export const quints = sqliteTable('quints', {
  graph: text('graph').notNull(),
  subject: text('subject').notNull(),
  predicate: text('predicate').notNull(),
  object: text('object').notNull(),
  vector: text('vector'), // JSON serialized float array, will switch to vector extension later
}, (table) => ({
  // 6 indexes aligned with quadstore
  idx_spog: index('idx_spog').on(table.subject, table.predicate, table.object, table.graph),
  idx_ogsp: index('idx_ogsp').on(table.object, table.graph, table.subject, table.predicate),
  idx_gspo: index('idx_gspo').on(table.graph, table.subject, table.predicate, table.object),
  idx_sopg: index('idx_sopg').on(table.subject, table.object, table.predicate, table.graph),
  idx_pogs: index('idx_pogs').on(table.predicate, table.object, table.graph, table.subject),
  idx_gpos: index('idx_gpos').on(table.graph, table.predicate, table.object, table.subject),
}));

export type QuintRow = typeof quints.$inferSelect;
export type NewQuintRow = typeof quints.$inferInsert;
