import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLoggerFor } from 'global-logger-factory';
import type { ResolvedAgentConfig } from '../../../agents/config/types';
import type { McpServerConfig } from '../../../agents/types';

export interface CodexRuntimeProjection {
  codexHome: string;
  baseUrl?: string;
  apiKey?: string;
  wireApi?: 'responses' | 'chat';
  model?: string;
  agentConfig?: ResolvedAgentConfig;
}

/**
 * Projects Xpod's Pod-hosted Agent Profile into Codex's native local runtime
 * files. The Pod profile remains the source of truth; these files are an
 * invocation-scoped compatibility view for codex-acp.
 */
export class CodexRuntimeProjector {
  private readonly logger = getLoggerFor(this);

  public project(options: CodexRuntimeProjection): void {
    this.ensureDir(options.codexHome);
    this.projectSkills(options.codexHome, options.agentConfig);
    this.writeConfigAndAuth(options);
  }

  private writeConfigAndAuth(options: CodexRuntimeProjection): void {
    const configPath = path.join(options.codexHome, 'config.toml');
    const authPath = path.join(options.codexHome, 'auth.json');

    try {
      const baseUrl = options.baseUrl?.trim();
      if (baseUrl) {
        fs.writeFileSync(configPath, this.renderConfigToml({
          baseUrl,
          wireApi: options.wireApi ?? 'responses',
          model: options.model,
          mcpServers: options.agentConfig?.mcpServers,
        }), { encoding: 'utf8' });
      }
    } catch (error) {
      this.logger.debug(`Failed to write Codex config.toml: ${String(error)}`);
    }

    try {
      const apiKey = options.apiKey?.trim();
      if (apiKey) {
        fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: apiKey }), { encoding: 'utf8' });
      }
    } catch (error) {
      this.logger.debug(`Failed to write Codex auth.json: ${String(error)}`);
    }
  }

  private renderConfigToml(options: {
    baseUrl: string;
    wireApi: 'responses' | 'chat';
    model?: string;
    mcpServers?: Record<string, McpServerConfig>;
  }): string {
    const lines = [
      'model_provider = "codex"',
      options.model ? `model = ${JSON.stringify(options.model)}` : undefined,
      '',
      '[model_providers.codex]',
      'name = "codex"',
      `base_url = ${JSON.stringify(options.baseUrl)}`,
      `wire_api = ${JSON.stringify(options.wireApi)}`,
      'requires_openai_auth = true',
      ...this.renderMcpServers(options.mcpServers),
      '',
    ].filter((line): line is string => typeof line === 'string');

    return lines.join('\n');
  }

  private projectSkills(codexHome: string, agentConfig?: ResolvedAgentConfig): void {
    const skillsRoot = path.join(codexHome, 'skills');
    this.ensureDir(skillsRoot);

    for (const skill of agentConfig?.skills ?? []) {
      const skillDir = path.join(skillsRoot, this.sanitizeFileSegment(skill.name));
      this.ensureDir(skillDir);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content, { encoding: 'utf8' });
    }
  }

  private renderMcpServers(servers?: Record<string, McpServerConfig>): string[] {
    if (!servers || Object.keys(servers).length === 0) {
      return [];
    }

    const lines: string[] = [''];
    for (const [name, config] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`[mcp_servers.${this.tomlBareKey(name)}]`);
      const type = this.codexMcpServerType(config);
      if (type) {
        lines.push(`type = ${JSON.stringify(type)}`);
      }
      if (typeof config.command === 'string' && config.command.length > 0) {
        lines.push(`command = ${JSON.stringify(config.command)}`);
      }
      if (Array.isArray(config.args)) {
        lines.push(`args = ${JSON.stringify(config.args)}`);
      }
      if (typeof config.url === 'string' && config.url.length > 0) {
        lines.push(`url = ${JSON.stringify(config.url)}`);
      }
      if (config.env && Object.keys(config.env).length > 0) {
        lines.push(`env = ${this.renderTomlInlineTable(config.env)}`);
      }
      if (config.headers && Object.keys(config.headers).length > 0) {
        lines.push(`headers = ${this.renderTomlInlineTable(config.headers)}`);
      }
      lines.push('enabled = true', '');
    }
    return lines;
  }

  private codexMcpServerType(config: McpServerConfig): string | undefined {
    if (config.type === 'http') return 'streamable_http';
    if (config.type === 'sse') return 'sse';
    if (config.type === 'stdio') return 'stdio';
    return undefined;
  }

  private renderTomlInlineTable(values: Record<string, string>): string {
    const body = Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${this.tomlBareKey(key)} = ${JSON.stringify(value)}`)
      .join(', ');
    return `{ ${body} }`;
  }

  private tomlBareKey(value: string): string {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
  }

  private sanitizeFileSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort: agent binaries may create runtime directories themselves
    }
  }
}
