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
  objectKind: text('object_kind'),
  objectKey: text('object_key'),
  objectText: text('object_text'),
  objectDigest: text('object_digest'),
  graph: text('graph').notNull(),
  subject: text('subject').notNull(),
  predicate: text('predicate').notNull(),
  object: text('object').notNull(),
  vector: text('vector'), // JSON serialized float array, will switch to vector extension later
}, (table) => ({
  idx_graph: index('idx_quints_graph').on(table.graph),
  idx_subject: index('idx_quints_subject').on(table.subject),
  idx_predicate: index('idx_quints_predicate').on(table.predicate),
  idx_object_key: index('idx_quints_object_key').on(table.objectKind, table.objectKey),
  idx_predicate_object_key: index('idx_quints_predicate_object_key').on(table.predicate, table.objectKind, table.objectKey),
  idx_predicate_object_digest: index('idx_quints_predicate_object_digest').on(table.predicate, table.objectKind, table.objectDigest),
  idx_gsp: index('idx_quints_gsp').on(table.graph, table.subject, table.predicate),
  idx_sp: index('idx_quints_sp').on(table.subject, table.predicate),
  idx_gp: index('idx_quints_gp').on(table.graph, table.predicate),
}));

export type QuintRow = typeof quints.$inferSelect;
export type NewQuintRow = typeof quints.$inferInsert;
