/**
 * Agent Meta Schema - Per-agent .meta TTL document
 *
 * Each agent folder has a .meta auxiliary resource:
 *   /agents/{agentId}/.meta
 *
 * This is an adapter for the existing AGENTS.md + .meta runtime config layout,
 * not a durable shared model. Durable Agent resources belong in
 * @undefineds.co/models; the extra runtime fields here are local runtime
 * adapter inputs until the shared model owns that contract.
 */

import {
  DCTerms,
  FOAF,
  VCARD,
  aiModelResource,
  credentialResource,
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
import { UDFS } from '../../vocab/udfs';

export const AgentMetaSchema = solidSchema({
  id: string('id').primaryKey(),
  name: string('name').predicate(FOAF.name),
  description: text('description').predicate(DCTerms.description),
  avatarUrl: uri('avatarUrl').predicate(VCARD.hasPhoto),
  instructions: text('instructions').predicate(UDFS('systemPrompt')),
  provider: uri('provider').predicate(UDFS('provider')),
  runtimeKind: string('runtimeKind').predicate(UDFS('runtimeKind')),
  credential: uri('credential').predicate(UDFS('credential')).link(credentialResource),
  model: uri('model').predicate(UDFS('model')).link(aiModelResource),
  enabled: string('enabled').predicate(UDFS('enabled')).default('true'),
  permissionMode: string('permissionMode').predicate(UDFS('permissionMode')),
  allowedTools: text('allowedTools').array().predicate(UDFS('allowedTool')),
  disallowedTools: text('disallowedTools').array().predicate(UDFS('disallowedTool')),
  skills: uri('skills').array().predicate(UDFS('skill')),
  mcpServers: text('mcpServers').array().predicate(UDFS('mcpServer')),
  temperature: real('temperature').predicate(UDFS('temperature')).default(0.7),
  tools: text('tools').array().predicate(UDFS('tools')),
  contextRound: integer('contextRound').predicate(UDFS('contextRound')).default(4),
  maxTurns: integer('maxTurns').predicate(UDFS('maxTurns')),
  timeout: integer('timeout').predicate(UDFS('timeout')),
  ttsModel: uri('ttsModel').predicate(UDFS('ttsModel')).link(aiModelResource),
  videoModel: uri('videoModel').predicate(UDFS('videoModel')).link(aiModelResource),
  createdAt: timestamp('createdAt').predicate(DCTerms.created).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').predicate(DCTerms.modified).notNull().defaultNow(),
  deletedAt: timestamp('deletedAt').predicate(UDFS('deletedAt')),
}, {
  type: UDFS.AgentConfig,
  namespace: UDFS,
});
