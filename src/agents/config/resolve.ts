/**
 * Agent Config Resolver
 *
 * Reads /agents/{agentId}/AGENT.md + /agents/{agentId}/.meta from Pod,
 * resolves provider/credential/model URIs, and assembles a ResolvedAgentConfig.
 *
 * Flow:
 * 1. Fetch AGENT.md → parse frontmatter + body
 * 2. Query .meta TTL → get provider/credential/model URIs
 * 3. Resolve URIs → Provider, Credential, Model records
 * 4. Fetch skills (if any) → concatenate prompt content
 * 5. Convert MCP server defs → McpServerConfig map
 * 6. Return ResolvedAgentConfig
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { parseAgentMd } from './parse-agent-md';
import { AgentMetaSchema } from './agent-meta-schema';
import { Provider } from '../../ai/schema/provider';
import { Credential } from '../../credential/schema/tables';
import { Model } from '../../ai/schema/model';
import type { ResolvedAgentConfig, AgentMcpServerDef } from './types';
import type { ExecutorType } from '../types';
import type { McpServerConfig } from '../types';

const logger = getLoggerFor('AgentConfigResolver');

function isExecutorType(value: string | undefined): value is ExecutorType {
  return value === 'codebuddy' || value === 'claude';
}

async function resolveModelId(
  db: any,
  modelRef: string | null | undefined,
): Promise<string | undefined> {
  if (!modelRef) {
    return undefined;
  }

  const modelRecord = await db.findByIri(Model, modelRef);
  return modelRecord?.id ?? undefined;
}

interface ResolveContext {
  podBaseUrl: string;
  authenticatedFetch: typeof fetch;
  webId?: string;
}

/**
 * Resolve a complete agent config from Pod storage.
 *
 * @param agentId - Agent folder name (e.g. 'secretary')
 * @param ctx - Pod access context
 * @returns Fully resolved config, or null if agent not found / disabled
 */
export async function resolveAgentConfig(
  agentId: string,
  ctx: ResolveContext,
): Promise<ResolvedAgentConfig | null> {
  const { podBaseUrl, authenticatedFetch, webId } = ctx;

  // 1. Fetch AGENT.md
  const agentMdUrl = new URL(`/agents/${agentId}/AGENT.md`, podBaseUrl).href;
  const mdResponse = await authenticatedFetch(agentMdUrl);
  let frontmatter: ReturnType<typeof parseAgentMd>['frontmatter'] = {};
  let promptFromMarkdown = '';
  if (mdResponse.ok) {
    const mdContent = await mdResponse.text();
    const parsed = parseAgentMd(mdContent);
    frontmatter = parsed.frontmatter;
    promptFromMarkdown = parsed.body;
  } else {
    logger.warn(`AGENT.md not found for ${agentId}: ${mdResponse.status}, fallback to Pod metadata`);
  }

  // 2. Query .meta
  const metaTable = AgentMetaSchema.table('AgentMeta', {
    base: `/agents/${agentId}/.meta`,
    subjectTemplate: '#{id}',
  });

  const session = {
    info: { isLoggedIn: true, webId },
    fetch: authenticatedFetch,
  };
  const db: any = drizzle(session, {
    schema: {
      agentMeta: metaTable,
      provider: Provider,
      credential: Credential,
      model: Model,
    },
  });

  const metaRecord = await db.query.agentMeta.findFirst();
  if (!metaRecord) {
    logger.warn(`.meta not found for agent ${agentId}`);
    return null;
  }

  if (metaRecord.enabled === 'false') {
    logger.debug(`Agent ${agentId} is disabled`);
    return null;
  }

  // 3. Resolve provider
  const providerUri = metaRecord.provider;
  if (!providerUri) {
    logger.error(`Agent ${agentId} has no provider in .meta`);
    return null;
  }
  const provider = await db.findByIri(Provider, providerUri);
  if (!provider) {
    logger.error(`Provider not found: ${providerUri}`);
    return null;
  }

  const runtimeKind = metaRecord.runtimeKind;
  if (!isExecutorType(runtimeKind)) {
    logger.error(`Agent ${agentId} has invalid runtimeKind: ${runtimeKind ?? '(missing)'}`);
    return null;
  }

  // 4. Resolve credential
  const credentialUri = metaRecord.credential;
  let apiKey = '';
  let baseUrl = provider.baseUrl ?? undefined;
  let proxyUrl: string | undefined;

  if (credentialUri) {
    const cred = await db.findByIri(Credential, credentialUri);
    if (cred) {
      apiKey = (cred as any).apiKey ?? '';
      baseUrl = (cred as any).baseUrl ?? baseUrl;
      proxyUrl = (cred as any).proxyUrl ?? undefined;
    }
  }

  // 5. Resolve model
  let modelName = await resolveModelId(db, provider.defaultModel ?? provider.hasModel);
  const modelUri = metaRecord.model;
  if (modelUri) {
    const resolvedModel = await resolveModelId(db, modelUri);
    if (resolvedModel) {
      modelName = resolvedModel;
    }
  }

  // 6. Resolve skills
  const skillsContent = await resolveSkills(
    frontmatter.skills ?? [],
    podBaseUrl,
    agentId,
    authenticatedFetch,
  );

  // 7. Convert MCP server defs
  const mcpServers = convertMcpServers(frontmatter['mcp-servers'] ?? []);

  // 8. Assemble
  const systemPrompt = promptFromMarkdown || metaRecord.instructions || '';

  return {
    id: agentId,
    displayName: metaRecord.name ?? frontmatter.name ?? agentId,
    description: metaRecord.description ?? frontmatter.description,
    systemPrompt,
    executorType: runtimeKind,
    apiKey,
    baseUrl,
    proxyUrl,
    model: modelName,
    maxTurns: frontmatter['max-turns'] ?? metaRecord.maxTurns,
    allowedTools: Array.isArray(frontmatter['allowed-tools'])
      ? frontmatter['allowed-tools']
      : undefined,
    disallowedTools: Array.isArray(frontmatter['disallowed-tools'])
      ? frontmatter['disallowed-tools']
      : undefined,
    permissionMode: frontmatter['permission-mode'],
    mcpServers,
    skillsContent: skillsContent || undefined,
    enabled: metaRecord.enabled !== 'false',
  };
}

/**
 * Resolve skill URIs to concatenated prompt content.
 *
 * Skills can be:
 * - Absolute: /skills/drizzle-solid → fetch /skills/drizzle-solid/SKILL.md
 * - Relative: ./skills/custom → fetch /agents/{agentId}/skills/custom/SKILL.md
 */
async function resolveSkills(
  skillRefs: string[],
  podBaseUrl: string,
  agentId: string,
  authenticatedFetch: typeof fetch,
): Promise<string> {
  if (skillRefs.length === 0) return '';

  const parts: string[] = [];

  for (const ref of skillRefs) {
    const skillPath = ref.startsWith('./')
      ? `/agents/${agentId}/${ref.slice(2)}/SKILL.md`
      : `${ref}/SKILL.md`;

    const url = new URL(skillPath, podBaseUrl).href;
    try {
      const res = await authenticatedFetch(url);
      if (res.ok) {
        const content = await res.text();
        // Parse SKILL.md — extract body (skip frontmatter)
        const { body } = parseAgentMd(content);
        if (body) {
          parts.push(body);
        }
      } else {
        logger.warn(`Skill not found: ${ref} (${res.status})`);
      }
    } catch (err) {
      logger.warn(`Failed to fetch skill ${ref}:`, err);
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Convert AGENT.md MCP server definitions to McpServerConfig map.
 */
function convertMcpServers(
  defs: AgentMcpServerDef[],
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};

  for (const def of defs) {
    const config: McpServerConfig = {};

    if (def.transport) {
      config.type = def.transport;
    } else if (def.command) {
      config.type = 'stdio';
    } else if (def.url) {
      config.type = 'sse';
    }

    if (def.command) config.command = def.command;
    if (def.args) config.args = def.args;
    if (def.env) config.env = def.env;
    if (def.url) config.url = def.url;
    if (def.headers) config.headers = def.headers;

    result[def.name] = config;
  }

  return result;
}
