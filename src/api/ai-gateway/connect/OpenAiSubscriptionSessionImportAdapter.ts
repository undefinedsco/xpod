import {
  FileSessionImportAdapter,
  type FileSessionImportAdapterOptions,
  type LocalSessionImportAdapter,
  type LocalSessionImportInput,
  type LocalSessionImportResult,
} from './FileSessionImportAdapter';
import { OPENAI_CODEX_SESSION_IMPORT_PROFILE } from './SessionImportProfiles';

export type {
  LocalSessionImportAdapter,
  LocalSessionImportInput,
  LocalSessionImportResult,
};

export interface OpenAiSubscriptionSessionImportAdapterOptions extends Omit<FileSessionImportAdapterOptions, 'profile'> {}

export class OpenAiSubscriptionSessionImportAdapter extends FileSessionImportAdapter implements LocalSessionImportAdapter {
  public constructor(options: OpenAiSubscriptionSessionImportAdapterOptions = {}) {
    super({
      ...options,
      profile: OPENAI_CODEX_SESSION_IMPORT_PROFILE,
    });
  }
}
