import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BaseAiClientConfigAdapter,
  AiClientConfigError,
  looksLikePreviousXpodValue,
  contentFingerprint,
  normalizeV1Endpoint,
  parseJsonObject,
  profileApiKey,
  stringifyJson,
} from './base-adapter';
import type { AiClientConfigPlan, AiClientModelReference, AiConnectionsClientProfile, ClientInspection, ClientVerification } from './types';

const START = '# >>> xpod-ai-connections managed';
const END = '# <<< xpod-ai-connections managed';

export interface CodexConfigAdapterOptions {
  homeDir?: string;
}

export class CodexConfigAdapter extends BaseAiClientConfigAdapter {
  private readonly configPath: string;
  private readonly authPath: string;
  private readonly catalogPath: string;
  private readonly nativeModelsPath: string;

  public constructor(options: CodexConfigAdapterOptions = {}) {
    const codexHome = path.join(options.homeDir ?? os.homedir(), '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');
    super('codex', 'codex', [configPath], codexHome);
    this.configPath = configPath;
    this.authPath = authPath;
    this.catalogPath = path.join(codexHome, 'xpod-model-catalog.json');
    this.nativeModelsPath = path.join(codexHome, 'models_cache.json');
  }

  protected override normalizeProfile(profile: AiConnectionsClientProfile): AiConnectionsClientProfile {
    // Refreshing the menu must not select a different model on the user's behalf.
    return profile.model?.trim() ? super.normalizeProfile(profile) : { ...profile, model: undefined };
  }

  public override async inspect(): Promise<ClientInspection> {
    const inspection = await super.inspect();
    const state = await this.readState();
    if (!state?.files.some((file) => file.path === this.catalogPath)) return inspection;
    await this.rejectSymlink(this.catalogPath);
    const catalog = await this.readOptional(this.catalogPath);
    if (catalog !== undefined && contentFingerprint(catalog) === state.projectionHashes?.[this.catalogPath]) {
      return { ...inspection, configPaths: [...inspection.configPaths, this.catalogPath] };
    }
    const withoutFingerprint = { ...inspection };
    delete withoutFingerprint.apiKeyFingerprint;
    return { ...withoutFingerprint, projectionMatches: false, configPaths: [...inspection.configPaths, this.catalogPath] };
  }

  public override async plan(profile: AiConnectionsClientProfile): Promise<AiClientConfigPlan> {
    const plan = await super.plan(profile);
    const state = await this.readState();
    const legacyAuth = state?.files.find((file) => file.path === this.authPath);
    if (!legacyAuth) return plan;

    await this.rejectSymlink(this.authPath);
    const current = await this.readOptional(this.authPath);
    if (!this.ownsLegacyAuth(current, state?.apiKeyFingerprint)) return plan;

    let original: string | undefined;
    if (legacyAuth.existed) {
      if (!legacyAuth.backupPath) throw new Error('Missing Codex auth.json backup metadata');
      await this.rejectSymlink(legacyAuth.backupPath);
      original = await this.readOptional(legacyAuth.backupPath);
      if (original === undefined) throw new Error('Missing Codex auth.json backup; refusing to guess login state');
    }
    // Migrate auth in the same transaction without keeping it in the new ownership state.
    plan.writes.splice(plan.writes.length - 1, 0, {
      path: this.authPath,
      content: restoreLegacyAuth(current, original, legacyAuth.existed),
      expectedContentHash: contentFingerprint(current!),
    });
    return plan;
  }

  private ownsLegacyAuth(current: string | undefined, fingerprint: string | undefined): boolean {
    if (!fingerprint || current === undefined) return false;
    const auth = parseJsonObject(current, 'Codex auth.json');
    return typeof auth.OPENAI_API_KEY === 'string' && contentFingerprint(auth.OPENAI_API_KEY) === fingerprint;
  }

  protected async project(
    profile: AiConnectionsClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>> {
    const baseContent = current.get(this.configPath) ?? '';
    let nativeModels: Record<string, unknown>[] = [];
    if (profile.activeModels?.length) {
      const nativeCatalog = await this.readOptional(this.nativeModelsPath);
      if (nativeCatalog !== undefined) nativeModels = readCatalogModels(nativeCatalog, 'Codex native model cache');
    }
    let catalog = codexModelCatalog(profile.activeModels, nativeModels);
    const state = await this.readState();
    const ownsCatalog = state?.files.some((file) => file.path === this.catalogPath);
    if (catalog !== undefined || ownsCatalog) {
      await this.rejectSymlink(this.catalogPath);
      const existingCatalog = await this.readOptional(this.catalogPath);
      current.set(this.catalogPath, existingCatalog);
      catalog ??= existingCatalog;
      if (catalog === undefined) throw new Error('Codex model catalog is missing; refresh with the current Gateway models');
    }
    const unmanagedConfig = this.removeManagedBlock(baseContent);
    if (hasUnmanagedModelProviderTable(unmanagedConfig)) {
      throw new Error('Codex config.toml already defines [model_providers.xpod] outside managed block');
    }
    const config = stripRootLevelModelKeys(unmanagedConfig).trim();
    const model = profile.model?.trim();
    const rootBlock = [
      START,
      'model_provider = "xpod"',
      ...(model ? [`model = ${JSON.stringify(model)}`] : rootLevelLines(baseContent, 'model')),
      ...(catalog !== undefined ? [`model_catalog_json = ${JSON.stringify(this.catalogPath)}`] : rootLevelLines(baseContent, 'model_catalog_json')),
      END,
    ].join('\n');
    const providerBlock = [
      START,
      '',
      '[model_providers.xpod]',
      'name = "Xpod AI Connection"',
      `base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      `experimental_bearer_token = ${JSON.stringify(profileApiKey(profile))}`,
      END,
      '',
    ].join('\n');
    const projected = new Map([[this.configPath, `${rootBlock}\n\n${config}${config ? '\n\n' : ''}${providerBlock}`]]);
    if (catalog !== undefined) projected.set(this.catalogPath, catalog);
    return projected;
  }

  protected async verifyProjection(profile: AiConnectionsClientProfile): Promise<ClientVerification> {
    try {
      const config = await fs.promises.readFile(this.configPath, 'utf8');
      const modelMatches = profile.model
        ? rootLevelLines(config, 'model').some((line) => line.trim() === `model = ${JSON.stringify(profile.model)}`)
        : true;
      const provider = tableLines(config, 'model_providers.xpod');
      const state = await this.readState();
      const ownsCatalog = state?.files.some((file) => file.path === this.catalogPath);
      let catalogMatches = true;
      if (profile.activeModels !== undefined || ownsCatalog) {
        const catalog = await fs.promises.readFile(this.catalogPath, 'utf8');
        // Validate the applied snapshot, not a cache Codex may have refreshed since planning.
        const expectedCatalog = codexModelCatalog(profile.activeModels, readCatalogModels(catalog, 'Codex model catalog'));
        catalogMatches = rootLevelLines(config, 'model_catalog_json')
          .includes(`model_catalog_json = ${JSON.stringify(this.catalogPath)}`) &&
          contentFingerprint(catalog) === state?.projectionHashes?.[this.catalogPath] &&
          (expectedCatalog === undefined || catalog === expectedCatalog);
      }
      const ok = rootLevelLines(config, 'model_provider').some((line) => line.trim() === 'model_provider = "xpod"') &&
        modelMatches && catalogMatches &&
        provider.includes(`base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`) &&
        provider.includes('wire_api = "responses"') &&
        provider.includes('requires_openai_auth = false') &&
        provider.includes(`experimental_bearer_token = ${JSON.stringify(profileApiKey(profile))}`);
      return ok ? { ok: true } : { ok: false, reason: 'Codex projection differs from the requested connection' };
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
    if (filePath === this.catalogPath) {
      const state = await this.readState();
      if (current === undefined || contentFingerprint(current) !== state?.projectionHashes?.[this.catalogPath]) {
        throw new Error('Codex model catalog changed since projection was applied; refusing restore to avoid data loss');
      }
      return originallyExisted ? original! : null;
    }
    if (filePath === this.authPath) {
      const state = await this.readState();
      if (!this.ownsLegacyAuth(current, state?.apiKeyFingerprint)) return current ?? null;
      return restoreLegacyAuth(current, original, originallyExisted);
    }

    let restored = this.removeManagedBlock(current ?? '').trim();
    const hasCurrentProvider = hasRootLevelKey(restored, 'model_provider');
    const originalContent = original ?? '';
    const originalHasXpodProjection = originalContent.includes(START)
      || rootLevelLines(originalContent, 'model_provider')
        .some((line) => /^\s*model_provider\s*=\s*["']xpod["']/.test(line));
    if (!hasCurrentProvider) {
      const originalRoot = originalHasXpodProjection
        ? []
        : rootLevelLines(originalContent, 'model_provider', 'model');
      if (originalRoot.length > 0) {
        restored = insertRootLevelLines(restored, originalRoot);
      }
    }
    if (!hasRootLevelKey(restored, 'model_catalog_json') && !originalHasXpodProjection) {
      const originalCatalog = rootLevelLines(originalContent, 'model_catalog_json');
      if (originalCatalog.length > 0) restored = insertRootLevelLines(restored, originalCatalog);
    }
    return !originallyExisted && !restored ? null : `${restored}${restored ? '\n' : ''}`;
  }

  protected override async currentApiKeyFingerprint(current: Map<string, string | undefined>): Promise<string | undefined> {
    const token = tableLines(current.get(this.configPath) ?? '', 'model_providers.xpod')
      .find((line) => /^experimental_bearer_token\s*=/u.test(line));
    if (token) {
      const value: unknown = JSON.parse(token.slice(token.indexOf('=') + 1).trim());
      return typeof value === 'string' ? contentFingerprint(value) : undefined;
    }
    // Old ownership records may still manage the global auth file until migration.
    if (current.has(this.authPath)) {
      const auth = parseJsonObject(current.get(this.authPath), 'Codex auth.json');
      return typeof auth.OPENAI_API_KEY === 'string' ? contentFingerprint(auth.OPENAI_API_KEY) : undefined;
    }
    return undefined;
  }

  private removeManagedBlock(content: string): string {
    let start = content.indexOf(START);
    while (start >= 0) {
      const end = content.indexOf(END, start);
      if (end < 0) throw new Error('Codex xpod managed block is incomplete');
      content = `${content.slice(0, start)}${content.slice(end + END.length)}`;
      start = content.indexOf(START);
    }
    return content;
  }
}

function tableLines(content: string, table: string): string[] {
  const lines: string[] = [];
  let selected = false;
  for (const line of content.split('\n')) {
    if (isTomlTableHeader(line)) {
      selected = line.trim() === `[${table}]`;
    } else if (selected) {
      lines.push(line.trim());
    }
  }
  return lines;
}

/**
 * Remove only the root-level keys owned by the Codex projection. A TOML key
 * with the same name inside a profile/provider table belongs to the user and
 * must remain untouched.
 */
function stripRootLevelModelKeys(content: string): string {
  const lines = content.split('\n');
  let inTable = false;
  let removedRootKey = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (isTomlTableHeader(line)) {
      inTable = true;
    }
    if (!inTable && isRootModelKey(line)) {
      removedRootKey = true;
      continue;
    }
    kept.push(line);
  }
  if (removedRootKey) {
    while (kept.length > 0 && kept[0]?.trim() === '') {
      kept.shift();
    }
  }
  return kept.join('\n');
}

function rootLevelLines(content: string, ...keys: string[]): string[] {
  const wanted = new Set(keys);
  const lines: string[] = [];
  let inTable = false;
  for (const line of content.split('\n')) {
    if (isTomlTableHeader(line)) {
      inTable = true;
    }
    if (!inTable && rootModelKey(line) && wanted.has(rootModelKey(line)!)) {
      lines.push(line);
    }
  }
  return lines;
}

function hasRootLevelKey(content: string, key: string): boolean {
  return rootLevelLines(content, key).length > 0;
}

function insertRootLevelLines(content: string, lines: string[]): string {
  const normalizedContent = content.replace(/^(?:\s*\n)+/u, '');
  return `${lines.join('\n')}${normalizedContent ? `\n\n${normalizedContent}` : ''}`;
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/u.test(line);
}

function hasUnmanagedModelProviderTable(content: string): boolean {
  for (const line of content.split('\n')) {
    if (!isTomlTableHeader(line) || /^\s*\[\[/.test(line)) {
      continue;
    }
    if (normalizeTomlTableName(line) === 'model_providers.xpod') {
      return true;
    }
  }
  return false;
}

function normalizeTomlTableName(line: string): string | undefined {
  const match = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/u.exec(line);
  if (!match) return undefined;
  const rawName = match[1].trim();
  const segments = parseTomlTableSegments(rawName);
  return segments.length === 1 ? undefined : normalizeTomlDottedKey(rawName);
}

function normalizeTomlDottedKey(content: string): string {
  const parts = parseTomlTableSegments(content);
  return parts.map((part) => removeTomlQuotes(part)).join('.');
}

function parseTomlTableSegments(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function removeTomlQuotes(value: string): string {
  if (value.length === 0) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isRootModelKey(line: string): boolean {
  return rootModelKey(line) !== undefined;
}

function rootModelKey(line: string): 'model_provider' | 'model' | 'model_catalog_json' | undefined {
  const match = /^\s*(model_provider|model|model_catalog_json)\s*=/.exec(line);
  return match?.[1] as 'model_provider' | 'model' | 'model_catalog_json' | undefined;
}

/** Revert only the two fields the old adapter owned; preserve refreshed OAuth state. */
function restoreLegacyAuth(current: string | undefined, original: string | undefined, originallyExisted: boolean): string | null {
  const restored = parseJsonObject(current, 'Codex auth.json');
  const before = parseJsonObject(original, 'Codex original auth.json');
  if (restored.auth_mode === 'apikey') {
    if (Object.prototype.hasOwnProperty.call(before, 'auth_mode')) {
      restored.auth_mode = before.auth_mode;
    } else {
      delete restored.auth_mode;
    }
  }
  if (Object.prototype.hasOwnProperty.call(before, 'OPENAI_API_KEY') &&
    !looksLikePreviousXpodValue(before.OPENAI_API_KEY)) {
    restored.OPENAI_API_KEY = before.OPENAI_API_KEY;
  } else {
    delete restored.OPENAI_API_KEY;
  }
  return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
}

/** Gateway ids are already routable; provider labels must not rewrite their slugs. */
function codexModelCatalog(models: readonly AiClientModelReference[] | undefined, nativeModels: Record<string, unknown>[] = []): string | undefined {
  if (models === undefined) return undefined;
  const available = models.filter((model) => model.availability === undefined || model.availability === 'available');
  if (available.length === 0) throw new AiClientConfigError('model_catalog_empty');
  const seen = new Set<string>();
  return stringifyJson({ models: available.map((model, index) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) throw new Error('Codex model catalog requires unique, non-empty Gateway model ids');
    seen.add(id);
    const native = nativeModels.find((entry) => entry.slug === id);
    const nativeModalities = Array.isArray(native?.input_modalities) ? native.input_modalities : ['text'];
    const declaredModalities = model.inputModalities?.filter((value) => value === 'text' || value === 'image');
    const modalities = declaredModalities?.filter((value) => !native || nativeModalities.includes(value)) ?? nativeModalities;
    const contextWindow = Number.isSafeInteger(model.contextWindow) && model.contextWindow! > 0 ? model.contextWindow : undefined;
    const reasoning = codexReasoningLevels(model);
    return {
      slug: id,
      description: 'Xpod Gateway model',
      supported_reasoning_levels: reasoning.levels,
      ...(reasoning.defaultLevel ? { default_reasoning_level: reasoning.defaultLevel } : {}),
      shell_type: 'shell_command',
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      truncation_policy: { mode: 'tokens', limit: 10000 },
      experimental_supported_tools: [],
      base_instructions: 'You are a coding assistant.',
      ...native,
      display_name: model.displayName?.trim() || native?.display_name || id,
      visibility: 'list',
      supported_in_api: true,
      priority: index,
      input_modalities: modalities.length ? [...new Set(modalities)] : ['text'],
      ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
      ...(contextWindow !== undefined && typeof native?.max_context_window === 'number'
        ? { max_context_window: Math.min(contextWindow, native.max_context_window) } : {}),
    };
  }) });
}

function codexReasoningLevels(model: AiClientModelReference): {
  levels: { effort: string; description: string }[];
  defaultLevel?: string;
} {
  if (model.provider !== 'deepseek' || !model.capabilities?.includes('reasoning')) return { levels: [] };
  return {
    levels: [
      { effort: 'low', description: 'DeepSeek low reasoning depth' },
      { effort: 'high', description: 'DeepSeek standard reasoning depth' },
      { effort: 'max', description: 'DeepSeek maximum reasoning depth' },
    ],
    defaultLevel: 'high',
  };
}

function readCatalogModels(content: string, label: string): Record<string, unknown>[] {
  const catalog = parseJsonObject(content, label);
  if (!Array.isArray(catalog.models) || catalog.models.some((model) =>
    !model || typeof model !== 'object' || Array.isArray(model) || typeof model.slug !== 'string')) {
    throw new Error(`${label} must contain a models array with string slugs`);
  }
  return catalog.models;
}
