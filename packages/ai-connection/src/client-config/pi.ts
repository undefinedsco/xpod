import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BaseAiClientConfigAdapter,
  activeModelReferences,
  looksLikePreviousXpodValue,
  normalizeV1Endpoint,
  parseJsonObject,
  profileApiKey,
  stringifyJson,
  stripLegacyXpodObject,
} from './base-adapter';
import type { AiConnectionClientProfile, ClientVerification } from './types';

export interface PiConfigAdapterOptions {
  homeDir?: string;
}

export class PiConfigAdapter extends BaseAiClientConfigAdapter {
  private readonly settingsPath: string;
  private readonly modelsPath: string;

  public constructor(options: PiConfigAdapterOptions = {}) {
    const dir = path.join(options.homeDir ?? os.homedir(), '.pi', 'agent');
    const settingsPath = path.join(dir, 'settings.json');
    const modelsPath = path.join(dir, 'models.json');
    super('pi', 'pi', [settingsPath, modelsPath], dir);
    this.settingsPath = settingsPath;
    this.modelsPath = modelsPath;
  }

  protected async project(
    profile: AiConnectionClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>> {
    const settings = parseJsonObject(current.get(this.settingsPath), 'Pi settings.json');
    const models = parseJsonObject(current.get(this.modelsPath), 'Pi models.json');
    const providers = models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers)
      ? { ...models.providers as Record<string, unknown> }
      : {};
    const model = profile.model;
    settings.defaultProvider = 'xpod';
    settings.defaultModel = model;
    providers.xpod = {
      baseUrl: normalizeV1Endpoint(profile.endpoint),
      apiKey: profileApiKey(profile),
      authHeader: true,
      api: 'openai-responses',
      models: activeModelReferences(profile),
    };
    models.providers = providers;
    return new Map([
      [this.settingsPath, stringifyJson(settings)],
      [this.modelsPath, stringifyJson(models)],
    ]);
  }

  protected async verifyProjection(profile: AiConnectionClientProfile): Promise<ClientVerification> {
    try {
      const models = parseJsonObject(await fs.promises.readFile(this.modelsPath, 'utf8'), 'Pi models.json');
      const xpod = (models.providers as Record<string, unknown> | undefined)?.xpod as
        Record<string, unknown> | undefined;
      const configuredModels = isObject(xpod?.models) || Array.isArray(xpod?.models) ? xpod?.models : undefined;
      const ok = xpod?.baseUrl === normalizeV1Endpoint(profile.endpoint) &&
        xpod.apiKey === profileApiKey(profile);
      const modelIds = Array.isArray(configuredModels)
        ? configuredModels.map((entry) => isObject(entry) && typeof entry.id === 'string' ? entry.id : undefined)
          .filter((id): id is string => id !== undefined)
        : [];
      return ok && modelIds.includes(profile.model ?? '')
        ? { ok: true }
        : { ok: false, reason: 'Pi projection differs from the requested connection' };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  protected async restoreFile(
    filePath: string,
    current: string | undefined,
    original: string | undefined,
    originallyExisted: boolean,
  ): Promise<string | null> {
    const restored = parseJsonObject(current, `Pi ${path.basename(filePath)}`);
    const before = parseJsonObject(original, `Pi original ${path.basename(filePath)}`);
    stripLegacyXpodObject(restored);
    if (filePath === this.settingsPath) {
      restoreOwnedProperty(restored, before, 'defaultProvider');
      restoreOwnedProperty(restored, before, 'defaultModel');
    } else {
      const restoredProviders = isObject(restored.providers) ? { ...restored.providers } : {};
      const beforeProviders = isObject(before.providers) ? before.providers : {};
      restoreOwnedProperty(restoredProviders, beforeProviders, 'xpod');
      if (Object.keys(restoredProviders).length > 0 || Object.prototype.hasOwnProperty.call(before, 'providers')) {
        restored.providers = restoredProviders;
      } else {
        delete restored.providers;
      }
    }
    return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
  }
}

function restoreOwnedProperty(
  target: Record<string, unknown>,
  original: Record<string, unknown>,
  key: string,
): void {
  if (key === 'xpod' || looksLikePreviousXpodValue(original[key])) {
    delete target[key];
  } else if (Object.prototype.hasOwnProperty.call(original, key)) {
    target[key] = original[key];
  } else {
    delete target[key];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
