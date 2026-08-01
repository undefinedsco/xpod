import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BaseAiClientConfigAdapter,
  looksLikePreviousXpodValue,
  normalizeV1Endpoint,
  parseJsonObject,
  stringifyJson,
} from './base-adapter';
import type { AiConnectionClientProfile, ClientVerification } from './types';

const START = '# >>> xpod-ai-connection managed';
const END = '# <<< xpod-ai-connection managed';

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
    profile: AiConnectionClientProfile,
    current: Map<string, string | undefined>,
  ): Promise<Map<string, string>> {
    const config = this.removeManagedBlock(current.get(this.configPath) ?? '')
      .split('\n')
      .filter((line) => !/^\s*model_provider\s*=/.test(line))
      .join('\n')
      .trimEnd();
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
    auth.OPENAI_API_KEY = profile.gatewayKey;
    return new Map([
      [this.configPath, `${config}${config ? '\n\n' : ''}${block}`],
      [this.authPath, stringifyJson(auth)],
    ]);
  }

  protected async verifyProjection(profile: AiConnectionClientProfile): Promise<ClientVerification> {
    try {
      const config = await fs.promises.readFile(this.configPath, 'utf8');
      const auth = parseJsonObject(await fs.promises.readFile(this.authPath, 'utf8'), 'Codex auth.json');
      const ok = config.includes('model_provider = "xpod"') &&
        config.includes(`base_url = ${JSON.stringify(normalizeV1Endpoint(profile.endpoint))}`) &&
        auth.OPENAI_API_KEY === profile.gatewayKey;
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
    const hasCurrentProvider = restored.split('\n').some((line) => /^\s*model_provider\s*=/.test(line));
    if (!hasCurrentProvider) {
      const originalProviders = (original ?? '')
        .split('\n')
        .filter((line) => /^\s*model_provider\s*=/.test(line) && !line.includes('xpod'));
      if (originalProviders.length > 0) {
        restored = `${originalProviders.join('\n')}${restored ? `\n${restored}` : ''}`;
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
