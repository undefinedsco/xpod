import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq, and } from '@undefineds.co/drizzle-solid';
import { selectAIConfigCredential } from '@undefineds.co/models';
import { CredentialReader } from './CredentialReader';
import type { AiCredential } from './types';
import {
  defaultAiCredentialSecretDecoder,
  providerTokenFromSecret,
  type AiCredentialSecretDecoder,
} from './AiCredentialSecret';
import { Credential } from '../../credential/schema/tables';
import { Provider } from '../schema/provider';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

const schema = {
  credential: Credential,
  provider: Provider,
};

export interface CredentialReaderImplOptions {
  /**
   * Reads the Pod credential secret. Defaults to the plaintext decoder, which
   * covers bare `apiKey` rows, `plaintext-v1` payloads, and the `PLAINTEXT`
   * envelope AI Connections writes; the container injects a vault-backed decoder
   * so wrapped Cloud secrets resolve too.
   */
  secretDecoder?: AiCredentialSecretDecoder;
}

export class CredentialReaderImpl extends CredentialReader {
  protected readonly logger = getLoggerFor(this);
  private readonly secretDecoder: AiCredentialSecretDecoder;

  public constructor(options: CredentialReaderImplOptions = {}) {
    super();
    this.secretDecoder = options.secretDecoder ?? defaultAiCredentialSecretDecoder;
  }

  public override async getAiCredential(
    podBaseUrl: string,
    providerId: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
    options: { credentialId?: string } = {},
  ): Promise<AiCredential | null> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db: any = drizzle(session, { schema });

      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
        ),
      });
      const providers = await db.query.provider.findMany();
      const enabled = credentials.filter((credential: any) => credentialEnabled(credential));
      const credentialRows = options.credentialId
        ? enabled.filter((credential: any) => matchesCredentialId(credential, options.credentialId))
        : enabled;
      const decrypted = await this.withDecodedSecrets(credentialRows, { podBaseUrl, webId });
      const selection = selectAIConfigCredential(providerId, decrypted, providers);

      if (!selection) {
        this.logger.debug(`No active credential found for provider: ${providerId}`);
        return null;
      }

      return {
        provider: selection.providerId,
        apiKey: selection.apiKey,
        credentialId: selection.credentialId,
        baseUrl: selection.baseUrl,
        proxyUrl: selection.proxyUrl,
      };
    } catch (error) {
      this.logger.error(`Failed to read credential for provider ${providerId}:`, error);
      return null;
    }
  }

  /**
   * AI Connections stores the provider secret in `encryptedSecret`; the shared
   * selector only understands a plain `apiKey`. Decode each row first so the
   * extension runtime sees the same credentials the Gateway does.
   */
  private async withDecodedSecrets(
    rows: any[],
    context: { podBaseUrl?: string; webId?: string },
  ): Promise<any[]> {
    return Promise.all(rows.map(async (row) => {
      if (typeof row?.apiKey === 'string' && row.apiKey.trim()) {
        return row;
      }
      try {
        const secret = await this.secretDecoder(row, {
          webId: context.webId ?? '',
          credentialIri: credentialIriFor(row, context.podBaseUrl),
          provider: credentialProviderId(row),
        });
        const apiKey = providerTokenFromSecret(secret);
        return apiKey ? { ...row, apiKey } : row;
      } catch (error) {
        this.logger.debug(`Failed to decode credential secret ${String(row?.id)}: ${error}`);
        return row;
      }
    }));
  }
}

function credentialEnabled(credential: any): boolean {
  const metadata = parseMetadata(credential?.metadata);
  return metadata?.enabled !== false;
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialIriFor(row: any, podBaseUrl?: string): string | undefined {
  const id = typeof row?.id === 'string' ? row.id : undefined;
  const iri = typeof row?.['@id'] === 'string' ? row['@id'] : undefined;
  if (iri) {
    return iri;
  }
  if (!id) {
    return undefined;
  }
  if (/^https?:\/\//.test(id)) {
    return id;
  }
  const base = podBaseUrl?.replace(/\/+$/, '');
  return base ? `${base}/settings/credentials.ttl#${id}` : undefined;
}

function credentialProviderId(row: any): string | undefined {
  const value = typeof row?.provider === 'string' ? row.provider : undefined;
  if (!value) {
    return undefined;
  }
  const fragment = value.lastIndexOf('#');
  const withoutFragment = fragment >= 0 && fragment < value.length - 1 ? value.slice(fragment + 1) : value;
  const clean = withoutFragment.replace(/\/+$/, '').replace(/\.ttl$/u, '');
  const segment = clean.slice(clean.lastIndexOf('/') + 1);
  return segment || undefined;
}

function matchesCredentialId(credential: any, requestedId?: string): boolean {
  if (!requestedId) return true;
  const normalizedRequested = normalizeCredentialId(requestedId);
  return normalizeCredentialId(credential?.id) === normalizedRequested
    || normalizeCredentialId(credential?.['@id']) === normalizedRequested;
}

function normalizeCredentialId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('#')) return trimmed.split('#').pop() || trimmed;
  const clean = trimmed.replace(/\/$/u, '');
  return clean.split('/').filter(Boolean).pop() ?? clean;
}
