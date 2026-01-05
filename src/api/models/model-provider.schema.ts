import { boolean, object, podTable, string, timestamp } from 'drizzle-solid'
import { LINQ, DCTerms } from './namespaces'

export const modelProviderTable = podTable('modelProviders', {
  id: string('id').primaryKey().predicate(LINQ.provider).notNull(),
  enabled: boolean('enabled').predicate(LINQ.status).default(false),
  apiKey: string('apiKey').predicate(LINQ.apiKey),
  baseUrl: string('baseUrl').predicate(LINQ.baseUrl),
  proxy: string('proxy').predicate(LINQ.proxy),
  models: object('models').array().predicate(LINQ.aiModels),
  updatedAt: timestamp('updatedAt').predicate(DCTerms.modified).notNull().defaultNow(),
}, {
  base: '/.data/model-providers/',
  sparqlEndpoint: '/.data/model-providers/-/sparql',
  type: LINQ.ModelProvider,
  namespace: LINQ,
  subjectTemplate: '{id}.ttl',
})

export type ModelProviderRow = typeof modelProviderTable.$inferSelect
export type ModelProviderInsert = typeof modelProviderTable.$inferInsert
export type ModelProviderUpdate = typeof modelProviderTable.$inferUpdate
