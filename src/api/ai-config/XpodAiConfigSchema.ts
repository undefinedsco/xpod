import { boolean, id, integer, podTable, string, uri } from '@undefineds.co/drizzle-solid';

const XPOD_AI_NAMESPACE = 'https://undefineds.co/ns/xpod#';

export const XPOD_AI = {
  prefix: 'xpod',
  uri: XPOD_AI_NAMESPACE,
  IndexPolicy: `${XPOD_AI_NAMESPACE}IndexPolicy`,
  ftsEnabled: `${XPOD_AI_NAMESPACE}ftsEnabled`,
  vectorEnabled: `${XPOD_AI_NAMESPACE}vectorEnabled`,
  progressiveIndexingEnabled: `${XPOD_AI_NAMESPACE}progressiveIndexingEnabled`,
  automaticIndexing: `${XPOD_AI_NAMESPACE}automaticIndexing`,
  refreshAfterSourceUpdate: `${XPOD_AI_NAMESPACE}refreshAfterSourceUpdate`,
  removeAfterSourceDeletion: `${XPOD_AI_NAMESPACE}removeAfterSourceDeletion`,
  textBackend: `${XPOD_AI_NAMESPACE}textBackend`,
  vectorBackend: `${XPOD_AI_NAMESPACE}vectorBackend`,
  previousModel: `${XPOD_AI_NAMESPACE}previousModel`,
  migrationStatus: `${XPOD_AI_NAMESPACE}migrationStatus`,
  migrationProgress: `${XPOD_AI_NAMESPACE}migrationProgress`,
} as const;

export const xpodAiConfigResource = podTable('xpodAiConfig', {
  id: id('id').default('config.ttl#{key}'),
  ftsEnabled: boolean('ftsEnabled').predicate(XPOD_AI.ftsEnabled).default(true),
  vectorEnabled: boolean('vectorEnabled').predicate(XPOD_AI.vectorEnabled).default(false),
  progressiveIndexingEnabled: boolean('progressiveIndexingEnabled')
    .predicate(XPOD_AI.progressiveIndexingEnabled)
    .default(true),
  automaticIndexing: boolean('automaticIndexing').predicate(XPOD_AI.automaticIndexing).default(true),
  refreshAfterSourceUpdate: boolean('refreshAfterSourceUpdate').predicate(XPOD_AI.refreshAfterSourceUpdate).default(true),
  removeAfterSourceDeletion: boolean('removeAfterSourceDeletion').predicate(XPOD_AI.removeAfterSourceDeletion).default(true),
  textBackend: string('textBackend').predicate(XPOD_AI.textBackend).default('auto'),
  vectorBackend: string('vectorBackend').predicate(XPOD_AI.vectorBackend).default('auto'),
  previousModel: uri('previousModel').predicate(XPOD_AI.previousModel),
  migrationStatus: string('migrationStatus').predicate(XPOD_AI.migrationStatus).default('idle'),
  migrationProgress: integer('migrationProgress').predicate(XPOD_AI.migrationProgress).default(0),
}, {
  base: '/settings/ai/',
  sparqlEndpoint: '/settings/ai/-/sparql',
  type: XPOD_AI.IndexPolicy,
  namespace: XPOD_AI,
});

export type XpodAiConfigRow = typeof xpodAiConfigResource.$inferSelect;
export type XpodAiConfigInsert = typeof xpodAiConfigResource.$inferInsert;
export type XpodAiConfigUpdate = typeof xpodAiConfigResource.$inferUpdate;
