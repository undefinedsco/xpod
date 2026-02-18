/**
 * Agent Meta Schema - Per-agent .meta TTL document
 *
 * Each agent folder has a .meta auxiliary resource:
 *   /agents/{agentId}/.meta
 *
 * Contains server-side references to provider, credential, and model.
 * This is NOT user-editable — managed by the server/admin UI.
 *
 * RDF example:
 * <#config> a udfs:AgentConfig ;
 *     udfs:displayName "Secretary" ;
 *     udfs:provider </settings/ai/agent-providers.ttl#claude> ;
 *     udfs:credential </settings/credentials.ttl#anthropic-key> ;
 *     udfs:model </settings/ai/models.ttl#claude-sonnet-4> ;
 *     udfs:enabled "true" .
 *
 * Uses SolidSchema (unbound) + .table() for per-agent dynamic paths:
 *   const table = AgentMetaSchema.table('AgentMeta', { base: `/agents/${agentId}/.meta` });
 */

import { solidSchema, string, uri } from 'drizzle-solid';
import { UDFS, UDFS_NAMESPACE } from '../../vocab';

/**
 * AgentMeta schema definition (unbound).
 *
 * Instantiate for a specific agent at query time:
 *   AgentMetaSchema.table('AgentMeta', { base: `/agents/${agentId}/.meta` })
 */
export const AgentMetaSchema = solidSchema(
  {
    id: string('id').primaryKey(),
    displayName: string('displayName'),
    provider: uri('provider'),
    credential: uri('credential'),
    model: uri('model'),
    enabled: string('enabled'),
  },
  {
    type: UDFS.AgentConfig,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '#{id}',
  },
);
