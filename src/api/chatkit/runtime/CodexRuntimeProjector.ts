import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLoggerFor } from 'global-logger-factory';
import type { ResolvedAgentConfig } from '../../../agents/config/types';
import type { McpServerConfig } from '../../../agents/types';
import { requireAiConnectionRuntimeConfig } from '../../../runtime/safe-env';

export interface CodexRuntimeProjection {
  codexHome: string;
  baseUrl?: string;
  apiKey?: string;
  wireApi?: 'responses' | 'chat';
  model?: string;
  agentConfig?: ResolvedAgentConfig;
}

export interface CodexRuntimeFileSystemPort {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  writeFileSync(path: fs.PathOrFileDescriptor, data: string, options: { encoding: BufferEncoding }): unknown;
}

/**
 * Projects Xpod's Pod-hosted Agent Profile into Codex's native local runtime
 * files. The Pod profile remains the source of truth; these files are an
 * invocation-scoped compatibility view for codex-acp.
 */
export class CodexRuntimeProjector {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly filesystem: CodexRuntimeFileSystemPort = fs) {}

  public project(options: CodexRuntimeProjection): void {
    const connection = requireAiConnectionRuntimeConfig(options, 'Codex runtime projection');
    this.ensureRequiredDir(options.codexHome, 'Codex home');
    this.writeConfigAndAuth({
      ...options,
      ...connection,
    });
    this.projectSkills(options.codexHome, options.agentConfig);
  }

  private writeConfigAndAuth(options: CodexRuntimeProjection & { baseUrl: string; apiKey: string }): void {
    const configPath = path.join(options.codexHome, 'config.toml');
    const authPath = path.join(options.codexHome, 'auth.json');

    this.writeRequiredFile(configPath, this.renderConfigToml({
      baseUrl: options.baseUrl,
      wireApi: options.wireApi ?? 'responses',
      model: options.model,
      mcpServers: options.agentConfig?.mcpServers,
    }), 'config.toml');
    this.writeRequiredFile(authPath, JSON.stringify({ OPENAI_API_KEY: options.apiKey }), 'auth.json');
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
    if (!this.ensureOptionalDir(skillsRoot)) {
      return;
    }

    for (const skill of agentConfig?.skills ?? []) {
      try {
        const skillDir = path.join(skillsRoot, this.sanitizeFileSegment(skill.name));
        this.filesystem.mkdirSync(skillDir, { recursive: true });
        this.filesystem.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content, { encoding: 'utf8' });
      } catch (error) {
        this.logger.debug(`Failed to project optional Codex skill '${skill.name}': ${String(error)}`);
      }
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

  private ensureRequiredDir(dir: string, label: string): void {
    try {
      this.filesystem.mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create required ${label} directory at ${dir}: ${this.errorMessage(error)}`);
    }
  }

  private ensureOptionalDir(dir: string): boolean {
    try {
      this.filesystem.mkdirSync(dir, { recursive: true });
      return true;
    } catch (error) {
      this.logger.debug(`Failed to create optional Codex directory at ${dir}: ${String(error)}`);
      return false;
    }
  }

  private writeRequiredFile(filePath: string, content: string, label: string): void {
    try {
      this.filesystem.writeFileSync(filePath, content, { encoding: 'utf8' });
    } catch (error) {
      throw new Error(`Failed to write required Codex ${label} at ${filePath}: ${this.errorMessage(error)}`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
