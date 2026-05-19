/**
 * Agent Config Resolver
 *
 * Reads a Pod-hosted Agent Profile:
 * - /agents/{agentId}/AGENTS.md is plain Markdown guidance.
 * - /agents/{agentId}/.meta#config is RDF runtime config.
 * - Skill refs point at shared SKILL.md documents in Pod storage.
 * - MCP servers are structured config entries, not mcp/*.json files.
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle } from '@undefineds.co/drizzle-solid';
import type { PodTable } from '@undefineds.co/drizzle-solid';
import { AgentMetaSchema } from './agent-meta-schema';
import { extractMarkdownBody, parseAgentInstructions } from './parse-agent-instructions';
import { Provider } from '../../ai/schema/provider';
import { Credential } from '../../credential/schema/tables';
import { Model } from '../../ai/schema/model';
import type {
  AgentMcpServerDef,
  AgentMetaRecord,
  AgentRuntimeKind,
  ResolvedAgentConfig,
  ResolvedAgentSkill,
} from './types';
import type { McpServerConfig } from '../types';

const logger = getLoggerFor('AgentConfigResolver');
const AGENT_META_RESOURCE_ID = '.meta#config';

interface ResolveContext {
  podBaseUrl: string;
  authenticatedFetch: typeof fetch;
  webId?: string;
}

interface AgentResourceLoaderOptions extends ResolveContext {
  agentId: string;
}

interface AgentProfileResources {
  instructions: string;
  skills: ResolvedAgentSkill[];
  skillsContent?: string;
}

function isRuntimeKind(value: string | undefined): value is AgentRuntimeKind {
  return value === 'codebuddy' || value === 'claude' || value === 'codex';
}

function createPodDb(ctx: ResolveContext, agentId: string): any {
  const agentMeta = createAgentMetaTable(agentId);
  return drizzle({
    info: {
      isLoggedIn: true,
      webId: ctx.webId,
    },
    fetch: ctx.authenticatedFetch,
  } as any, {
    schema: {
      agentConfig: agentMeta,
      provider: Provider,
      credential: Credential,
      model: Model,
    },
  });
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

/**
 * Resolve a complete agent config from Pod storage.
 *
 * @param agentId - Agent folder name, for example "secretary"
 * @param ctx - Pod access context
 * @returns Fully resolved config, or null if agent is missing / disabled / invalid
 */
export async function resolveAgentConfig(
  agentId: string,
  ctx: ResolveContext,
): Promise<ResolvedAgentConfig | null> {
  const db = createPodDb(ctx, agentId);
  return new AgentConfigResolver(
    agentId,
    db,
    db.schema?.agentConfig ?? createAgentMetaTable(agentId),
    new PodAgentResourceLoader({ agentId, ...ctx }),
  ).resolve();
}

class AgentConfigResolver {
  public constructor(
    private readonly agentId: string,
    private readonly db: any,
    private readonly metaTable: PodTable,
    private readonly resources: PodAgentResourceLoader,
  ) {}

  public async resolve(): Promise<ResolvedAgentConfig | null> {
    const metaRecord = await this.db.findById(this.metaTable, AGENT_META_RESOURCE_ID) as AgentMetaRecord | null;
    if (!metaRecord) {
      logger.warn(`Agent config not found for ${this.agentId}: ${AGENT_META_RESOURCE_ID}`);
      return null;
    }

    if (metaRecord.enabled === 'false') {
      return null;
    }

    const providerUri = metaRecord.provider;
    if (!providerUri) {
      logger.error(`Agent ${this.agentId} has no provider in .meta`);
      return null;
    }

    const provider = await this.db.findByIri(Provider, providerUri);
    if (!provider) {
      logger.error(`Provider not found: ${providerUri}`);
      return null;
    }

    const runtimeKind = metaRecord.runtimeKind;
    if (!isRuntimeKind(runtimeKind)) {
      logger.error(`Agent ${this.agentId} has invalid runtimeKind: ${runtimeKind ?? '(missing)'}`);
      return null;
    }

    const profileResources = await this.resources.load(toStringArray(metaRecord.skills));
    const credential = await this.resolveCredential(metaRecord.credential);
    const modelName = await this.resolveModelName(provider, metaRecord.model);
    const mcpServers = AgentMcpConfig.fromMeta(metaRecord.mcpServers).toRuntimeConfig();
    const systemPrompt = profileResources.instructions || metaRecord.instructions || '';

    return {
      id: this.agentId,
      displayName: metaRecord.name ?? this.agentId,
      description: metaRecord.description,
      systemPrompt,
      executorType: runtimeKind,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl ?? provider.baseUrl ?? undefined,
      proxyUrl: credential.proxyUrl,
      model: modelName,
      maxTurns: metaRecord.maxTurns,
      allowedTools: toStringArray(metaRecord.allowedTools),
      disallowedTools: toStringArray(metaRecord.disallowedTools),
      permissionMode: metaRecord.permissionMode,
      mcpServers,
      skillsContent: profileResources.skillsContent,
      skills: profileResources.skills,
      enabled: true,
    };
  }

  private async resolveCredential(credentialUri: string | undefined): Promise<{
    apiKey: string;
    baseUrl?: string;
    proxyUrl?: string;
  }> {
    if (!credentialUri) {
      return { apiKey: '' };
    }

    const credential = await this.db.findByIri(Credential, credentialUri);
    if (!credential) {
      logger.warn(`Credential not found: ${credentialUri}`);
      return { apiKey: '' };
    }

    return {
      apiKey: (credential as any).apiKey ?? '',
      baseUrl: (credential as any).baseUrl ?? undefined,
      proxyUrl: (credential as any).proxyUrl ?? undefined,
    };
  }

  private async resolveModelName(provider: any, modelUri: string | undefined): Promise<string | undefined> {
    const explicit = await resolveModelId(this.db, modelUri);
    if (explicit) {
      return explicit;
    }
    return resolveModelId(this.db, provider.defaultModel ?? provider.hasModel);
  }
}

function createAgentMetaTable(agentId: string): any {
  return AgentMetaSchema.table('AgentMeta', {
    base: `/agents/${agentId}/.meta`,
    subjectTemplate: '#{id}',
  });
}

class PodAgentResourceLoader {
  private readonly skillRefs: AgentSkillRefResolver;

  public readonly agentId: string;
  public readonly podBaseUrl: string;
  public readonly authenticatedFetch: typeof fetch;

  public constructor(options: AgentResourceLoaderOptions) {
    this.agentId = options.agentId;
    this.podBaseUrl = options.podBaseUrl;
    this.authenticatedFetch = options.authenticatedFetch;
    this.skillRefs = new AgentSkillRefResolver(options.agentId);
  }

  public async load(skillRefs: string[]): Promise<AgentProfileResources> {
    const instructions = await this.fetchAgentInstructions();
    const skills = await this.resolveSkillRefs(skillRefs);
    const skillsContent = skills
      .map((skill) => extractMarkdownBody(skill.content))
      .filter(Boolean)
      .join('\n\n---\n\n');
    return { instructions, skills, skillsContent: skillsContent || undefined };
  }

  private async fetchAgentInstructions(): Promise<string> {
    const agentsMdUrl = new URL(`/agents/${this.agentId}/AGENTS.md`, this.podBaseUrl).href;
    const response = await this.authenticatedFetch(agentsMdUrl);
    if (!response.ok) {
      logger.warn(`AGENTS.md not found for ${this.agentId}: ${response.status}, fallback to Pod metadata`);
      return '';
    }

    return parseAgentInstructions(await response.text());
  }

  private async resolveSkillRefs(refs: string[]): Promise<ResolvedAgentSkill[]> {
    const skills: ResolvedAgentSkill[] = [];

    for (const ref of refs) {
      const skill = await this.resolveSkillRef(ref);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  private async resolveSkillRef(ref: string): Promise<ResolvedAgentSkill | undefined> {
    const resolvedPath = this.skillRefs.resolvePath(ref);
    const url = new URL(resolvedPath, this.podBaseUrl).href;

    try {
      const response = await this.authenticatedFetch(url);
      if (!response.ok) {
        logger.warn(`Agent skill ref not found: ${ref} (${response.status})`);
        return undefined;
      }

      const content = (await response.text()).trim();
      if (!content) {
        return undefined;
      }

      return {
        name: this.skillRefs.resolveName(ref, resolvedPath),
        content,
      };
    } catch (error) {
      logger.warn(`Failed to fetch agent skill ref ${ref}:`, error);
      return undefined;
    }
  }
}

class AgentMcpConfig {
  public static fromMeta(value: AgentMetaRecord['mcpServers']): AgentMcpConfig {
    return new AgentMcpConfig(this.toMcpServerDefs(value));
  }

  private static toMcpServerDefs(value: AgentMetaRecord['mcpServers']): AgentMcpServerDef[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const defs: AgentMcpServerDef[] = [];
    for (const item of value) {
      const parsed = AgentMcpConfig.parseMcpServerDef(item);
      if (parsed) {
        defs.push(parsed);
      }
    }
    return defs;
  }

  private static parseMcpServerDef(value: unknown): AgentMcpServerDef | undefined {
    if (AgentMcpConfig.isAgentMcpServerDef(value)) {
      return value;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) {
      logger.warn(`Ignoring MCP server file ref '${value}'. Store structured MCP config in .meta instead.`);
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return AgentMcpConfig.isAgentMcpServerDef(parsed) ? parsed : undefined;
    } catch (error) {
      logger.warn('Invalid MCP server JSON in .meta:', error);
      return undefined;
    }
  }

  private static isAgentMcpServerDef(value: unknown): value is AgentMcpServerDef {
    return Boolean(value && typeof value === 'object' && typeof (value as AgentMcpServerDef).name === 'string');
  }

  private constructor(private readonly defs: AgentMcpServerDef[]) {}

  public toRuntimeConfig(): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};

    for (const def of this.defs) {
      result[def.name] = this.toRuntimeServerConfig(def);
    }

    return result;
  }

  private toRuntimeServerConfig(def: AgentMcpServerDef): McpServerConfig {
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

    return config;
  }
}

class AgentSkillRefResolver {
  public constructor(private readonly agentId: string) {}

  public resolvePath(ref: string): string {
    const normalized = this.normalizePackageRef(ref);
    if (normalized.startsWith('/')) {
      if (this.hasKnownMarkdownExtension(normalized)) {
        return normalized;
      }
      return `${normalized}/SKILL.md`;
    }

    const relative = normalized.startsWith('.codex/skills/') || normalized.startsWith('skills/')
      ? normalized
      : `skills/${normalized}`;
    if (this.hasKnownMarkdownExtension(relative)) {
      return `/agents/${this.agentId}/${relative}`;
    }
    return `/agents/${this.agentId}/${relative}/SKILL.md`;
  }

  public resolveName(ref: string, resolvedPath: string): string {
    const raw = this.normalizePackageRef(ref).replace(/\/$/, '');
    if (raw.endsWith('/SKILL.md')) {
      return this.sanitizeSkillName(raw.split('/').slice(-2, -1)[0] ?? 'skill');
    }

    const withoutPrefix = raw
      .replace(/^\/+/, '')
      .replace(/^\.codex\/skills\//, '')
      .replace(/^skills\//, '');
    if (withoutPrefix && !this.hasKnownMarkdownExtension(withoutPrefix)) {
      return this.sanitizeSkillName(withoutPrefix.split('/').filter(Boolean).pop() ?? withoutPrefix);
    }

    const segments = resolvedPath.split('/').filter(Boolean);
    const skillIndex = segments.lastIndexOf('SKILL.md');
    return this.sanitizeSkillName(skillIndex > 0 ? segments[skillIndex - 1] : 'skill');
  }

  private normalizePackageRef(ref: string): string {
    return ref.replace(/^\.\/+/, '').replace(/^\/+agents\/[^/]+\//, '/');
  }

  private sanitizeSkillName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  }

  private hasKnownMarkdownExtension(path: string): boolean {
    return /\.(md|markdown)$/i.test(path);
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}
