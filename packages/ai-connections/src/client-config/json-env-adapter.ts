import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BaseAiClientConfigAdapter,
  looksLikePreviousXpodValue,
  normalizeMessagesEndpoint,
  normalizeV1Endpoint,
  parseJsonObject,
  stringifyJson,
  stripLegacyXpodObject,
} from './base-adapter';
import type { AiConnectionsClientProfile, ClientVerification } from './types';

type EnvProjection = (profile: AiConnectionsClientProfile) => Record<string, string>;

abstract class JsonEnvAdapter extends BaseAiClientConfigAdapter {
  protected readonly settingsPath: string;

  protected constructor(
    client: string,
    settingsPath: string,
    private readonly envProjection: EnvProjection,
  ) {
    super(client, client === 'claude-code' ? 'claude' : 'codebuddy', [settingsPath], path.dirname(settingsPath));
    this.settingsPath = settingsPath;
  }

  protected async project(
    profile: AiConnectionsClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>> {
    const settings = parseJsonObject(current.get(this.settingsPath), `${this.client} settings.json`);
    const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? { ...settings.env as Record<string, unknown> }
      : {};
    Object.assign(env, this.envProjection(profile));
    settings.env = env;
    return new Map([[this.settingsPath, stringifyJson(settings)]]);
  }

  protected async verifyProjection(profile: AiConnectionsClientProfile): Promise<ClientVerification> {
    try {
      const settings = parseJsonObject(
        await fs.promises.readFile(this.settingsPath, 'utf8'),
        `${this.client} settings.json`,
      );
      const env = settings.env as Record<string, unknown> | undefined;
      const expected = this.envProjection(profile);
      const ok = env !== undefined && Object.entries(expected).every(([key, value]) => env[key] === value);
      return ok ? { ok: true } : {
        ok: false,
        reason: `${this.client} projection differs from the requested connection`,
      };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  protected async restoreFile(
    _filePath: string,
    current: string | undefined,
    original: string | undefined,
    originallyExisted: boolean,
  ): Promise<string | null> {
    const restored = parseJsonObject(current, `${this.client} settings.json`);
    const before = parseJsonObject(original, `${this.client} original settings.json`);
    stripLegacyXpodObject(restored);
    const restoredEnv = isObject(restored.env) ? { ...restored.env } : {};
    const beforeEnv = isObject(before.env) ? before.env : {};
    for (const key of Object.keys(this.envProjection({
      endpoint: 'https://owned.invalid',
      gatewayKey: 'owned',
      webId: 'https://owned.invalid/profile#me',
    }))) {
      if (Object.prototype.hasOwnProperty.call(beforeEnv, key) && !looksLikePreviousXpodValue(beforeEnv[key])) {
        restoredEnv[key] = beforeEnv[key];
      } else {
        delete restoredEnv[key];
      }
    }
    if (Object.keys(restoredEnv).length > 0 || Object.prototype.hasOwnProperty.call(before, 'env')) {
      restored.env = restoredEnv;
    } else {
      delete restored.env;
    }
    return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface JsonEnvConfigAdapterOptions {
  homeDir?: string;
}

export class ClaudeCodeConfigAdapter extends JsonEnvAdapter {
  public constructor(options: JsonEnvConfigAdapterOptions = {}) {
    const settingsPath = path.join(options.homeDir ?? os.homedir(), '.claude', 'settings.json');
    super('claude-code', settingsPath, (profile) => ({
      ANTHROPIC_BASE_URL: normalizeMessagesEndpoint(profile.endpoint),
      ANTHROPIC_AUTH_TOKEN: profile.gatewayKey,
    }));
  }
}

export class CodeBuddyConfigAdapter extends JsonEnvAdapter {
  public constructor(options: JsonEnvConfigAdapterOptions = {}) {
    const settingsPath = path.join(options.homeDir ?? os.homedir(), '.codebuddy', 'settings.json');
    super('codebuddy', settingsPath, (profile) => ({
      CODEBUDDY_BASE_URL: normalizeV1Endpoint(profile.endpoint),
      CODEBUDDY_API_KEY: profile.gatewayKey,
    }));
  }
}
