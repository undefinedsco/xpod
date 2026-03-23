import {
  DCTerms,
  FOAF,
  UDFS,
  VCARD,
  aiModelTable,
  credentialTable,
} from '@undefineds.co/models';
import {
  integer,
  real,
  solidSchema,
  string,
  text,
  timestamp,
  uri,
} from '@undefineds.co/drizzle-solid';

export interface CreateAgentSchemaOptions {
  nameRequired?: boolean;
}

export function createAgentSchema(options: CreateAgentSchemaOptions = {}) {
  const nameColumn = string('name').predicate(FOAF.name);

  return solidSchema({
    id: string('id').primaryKey(),
    name: options.nameRequired === false ? nameColumn : nameColumn.notNull(),
    description: text('description').predicate(DCTerms.description),
    avatarUrl: uri('avatarUrl').predicate(VCARD.hasPhoto),
    instructions: text('instructions').predicate(UDFS.systemPrompt),
    provider: uri('provider').predicate(UDFS.provider),
    runtimeKind: string('runtimeKind').predicate(UDFS.runtimeKind),
    credential: uri('credential').predicate(UDFS.credential).link(credentialTable),
    model: uri('model').predicate(UDFS.model).link(aiModelTable),
    enabled: string('enabled').predicate(UDFS.enabled).default('true'),
    temperature: real('temperature').predicate(UDFS.temperature).default(0.7),
    tools: text('tools').array().predicate(UDFS.tools),
    contextRound: integer('contextRound').predicate(UDFS.contextRound).default(4),
    maxTurns: integer('maxTurns').predicate(UDFS.maxTurns),
    timeout: integer('timeout').predicate(UDFS.timeout),
    ttsModel: uri('ttsModel').predicate(UDFS.ttsModel).link(aiModelTable),
    videoModel: uri('videoModel').predicate(UDFS.videoModel).link(aiModelTable),
    createdAt: timestamp('createdAt').predicate(DCTerms.created).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').predicate(DCTerms.modified).notNull().defaultNow(),
    deletedAt: timestamp('deletedAt').predicate(UDFS.deletedAt),
  }, {
    type: UDFS.AgentConfig,
    namespace: UDFS,
  });
}
