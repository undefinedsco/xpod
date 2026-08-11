import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BaseAiClientConfigAdapter,
  looksLikePreviousXpodValue,
  normalizeV1Endpoint,
  parseJsonObject,
  profileApiKey,
  stringifyJson,
} from './base-adapter';
import type { AiConnectionsClientProfile, ClientVerification } from './types';

const START = '# >>> xpod-ai-connections managed';
const END = '# <<< xpod-ai-connections managed';

export interface CodexConfigAdapterOptions {
  homeDir?: string;
}

export class CodexConfigAdapter extends BaseAiClientConfigAdapter {
  private readonly configPath: string;
  private readonly authPath: string;

  public constructor(options: CodexConfigAdapterOptions = {}) {
    const codexHome = path.join(options.homeDir ?? os.homedir(), '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');
    super('codex', 'codex', [configPath, authPath], codexHome);
    this.configPath = configPath;
    this.authPath = authPath;
  }

  protected async project(
    profile: AiConnectionsClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>> {
    const config = stripRootLevelModelKeys(
      this.removeManagedBlock(current.get(this.configPath) ?? ''),
    ).trimEnd();
    const model = profile.model?.trim();
    const block = [
      START,
      'model_provider = "xpod"',
      ...(model ? [`model = ${JSON.stringify(model)}`] : []),
      '',
      '[model_providers.xpod]',
      'name = "Xpod AI Connection"',
      `base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      END,
      '',
    ].join('\n');
    const auth = parseJsonObject(current.get(this.authPath), 'Codex auth.json');
    auth.OPENAI_API_KEY = profileApiKey(profile);
    return new Map([
      [this.configPath, `${config}${config ? '\n\n' : ''}${block}`],
      [this.authPath, stringifyJson(auth)],
    ]);
  }

  protected async verifyProjection(profile: AiConnectionsClientProfile): Promise<ClientVerification> {
    try {
      const config = await fs.promises.readFile(this.configPath, 'utf8');
      const auth = parseJsonObject(await fs.promises.readFile(this.authPath, 'utf8'), 'Codex auth.json');
      const ok = config.includes('model_provider = "xpod"') &&
        config.includes(`model = ${JSON.stringify(profile.model)}`) &&
        config.includes(`base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`) &&
        auth.OPENAI_API_KEY === profileApiKey(profile);
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
    if (filePath === this.authPath) {
      const restored = parseJsonObject(current, 'Codex auth.json');
      const before = parseJsonObject(original, 'Codex original auth.json');
      if (Object.prototype.hasOwnProperty.call(before, 'OPENAI_API_KEY') &&
        !looksLikePreviousXpodValue(before.OPENAI_API_KEY)) {
        restored.OPENAI_API_KEY = before.OPENAI_API_KEY;
      } else {
        delete restored.OPENAI_API_KEY;
      }
      return !originallyExisted && Object.keys(restored).length === 0 ? null : stringifyJson(restored);
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
    return !originallyExisted && !restored ? null : `${restored}${restored ? '\n' : ''}`;
  }

  private removeManagedBlock(content: string): string {
    const start = content.indexOf(START);
    if (start < 0) return content;
    const end = content.indexOf(END, start);
    if (end < 0) throw new Error('Codex xpod managed block is incomplete');
    return `${content.slice(0, start)}${content.slice(end + END.length)}`;
  }
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

function isRootModelKey(line: string): boolean {
  return rootModelKey(line) !== undefined;
}

function rootModelKey(line: string): 'model_provider' | 'model' | undefined {
  const match = /^\s*(model_provider|model)\s*=/.exec(line);
  return match?.[1] as 'model_provider' | 'model' | undefined;
}
