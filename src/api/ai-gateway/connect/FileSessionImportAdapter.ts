import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { ProviderSecret } from '../credentials/CredentialVault';
import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { SessionImportProfile } from './SessionImportProfiles';

const DEFAULT_MAX_SESSION_FILE_BYTES = 256 * 1024;

export interface LocalSessionImportResult {
  secret: ProviderSecret;
  /**
   * How the imported credential authenticates upstream. The import itself is
   * local, but an imported subscription session is still an OAuth credential.
   */
  credentialAuthMode?: 'deviceCodeOAuth' | 'local';
  accountLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalSessionImportInput {
  deployment: GatewayDeployment;
}

export interface LocalSessionImportAdapter {
  provider: string;
  offeringId: string;
  importSession(input: LocalSessionImportInput): Promise<LocalSessionImportResult>;
}

export interface FileSessionImportAdapterOptions {
  profile: SessionImportProfile;
  homeDir?: string;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  maxBytes?: number;
}

export class FileSessionImportAdapter implements LocalSessionImportAdapter {
  public readonly provider: string;
  public readonly offeringId: string;
  private readonly profile: SessionImportProfile;
  private readonly homeDir: string;
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  private readonly maxBytes: number;

  public constructor(options: FileSessionImportAdapterOptions) {
    this.profile = options.profile;
    this.provider = options.profile.provider;
    this.offeringId = options.profile.offeringId;
    this.homeDir = options.homeDir ?? os.homedir();
    this.readFile = options.readFile ?? fs.readFile;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_FILE_BYTES;
  }

  public async importSession(input: LocalSessionImportInput): Promise<LocalSessionImportResult> {
    if (input.deployment !== 'local') {
      throw new Error('local_session_import_unavailable_in_cloud');
    }
    const raw = await this.readSessionFile(this.profile.resolvePath(this.homeDir));
    const payload = parseJsonObject(raw);
    return this.profile.importSession(payload);
  }

  private async readSessionFile(filePath: string): Promise<string> {
    let raw: string;
    try {
      raw = await this.readFile(filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new Error('local_session_file_missing');
      }
      throw new Error('local_session_file_read_failed');
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      throw new Error('local_session_file_too_large');
    }
    return raw;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('local_session_file_invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('local_session_file_invalid_json');
  }
  return parsed as Record<string, unknown>;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
