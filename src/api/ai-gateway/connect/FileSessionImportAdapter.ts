import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  /** Environment snapshot used to resolve declared overrides; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  maxBytes?: number;
}

export class FileSessionImportAdapter implements LocalSessionImportAdapter {
  public readonly provider: string;
  public readonly offeringId: string;
  private readonly profile: SessionImportProfile;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  private readonly maxBytes: number;

  public constructor(options: FileSessionImportAdapterOptions) {
    this.profile = options.profile;
    this.provider = options.profile.provider;
    this.offeringId = options.profile.offeringId;
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.readFile = options.readFile ?? fs.readFile;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_FILE_BYTES;
  }

  public async importSession(input: LocalSessionImportInput): Promise<LocalSessionImportResult> {
    if (input.deployment !== 'local') {
      throw new Error('local_session_import_unavailable_in_cloud');
    }
    const filePath = this.profile.resolvePath(this.homeDir, this.env);
    const raw = await this.readSessionFile(filePath);
    const payload = parseJsonObject(raw);
    const result = this.profile.importSession(payload);
    return {
      ...result,
      // The profile declares the path; the adapter reports the file it actually read so the
      // path can never drift from the metadata the way a duplicated literal did before.
      metadata: withoutUndefined({
        ...result.metadata,
        sessionPath: homeRelativePath(this.homeDir, filePath),
      }),
    };
  }

  private async readSessionFile(filePath: string): Promise<string> {
    let raw: string;
    try {
      raw = await this.readFile(filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
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

/** `~/…` form for files under the home directory; undefined for any other location. */
function homeRelativePath(homeDir: string, filePath: string): string | undefined {
  const prefix = homeDir.endsWith(path.sep) ? homeDir : `${homeDir}${path.sep}`;
  return filePath.startsWith(prefix) ? `~${path.sep}${filePath.slice(prefix.length)}` : undefined;
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

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
