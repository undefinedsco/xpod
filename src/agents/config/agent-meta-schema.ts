/**
 * Agent Meta Schema - Per-agent .meta TTL document
 *
 * Each agent folder has a .meta auxiliary resource:
 *   /agents/{agentId}/.meta
 *
 * Uses the shared LinX/Xpod Agent contract with a different base path.
 */

import { createAgentSchema } from '../schema/create-agent-schema';

export const AgentMetaSchema: ReturnType<typeof createAgentSchema> = createAgentSchema({ nameRequired: false });
