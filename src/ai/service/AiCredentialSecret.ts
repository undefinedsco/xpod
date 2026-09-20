/**
 * Reading a Pod AI credential's secret.
 *
 * AI Connections stores the provider secret as an `encryptedSecret` envelope
 * (plaintext JSON envelope locally, a wrapped secret cell in Cloud), while some
 * older rows carry a bare `apiKey` property. Every consumer that needs the key —
 * the Gateway for chat, and the embedding/indexing paths — must read the secret
 * the same way, otherwise a key entered through AI Connections works for chat but
 * not for embeddings.
 */

export const PLAINTEXT_CREDENTIAL_ALGORITHM = 'PLAINTEXT';

export interface AiCredentialSecretContext {
  webId: string;
  /** Credential resource IRI, when the caller knows it (required by wrapped envelopes). */
  credentialIri?: string;
  /** Provider id, when the caller knows it (required by wrapped envelopes). */
  provider?: string;
}

export type AiCredentialSecret = Record<string, unknown>;

export type AiCredentialSecretDecoder = (
  row: Record<string, unknown>,
  context: AiCredentialSecretContext,
) => Promise<AiCredentialSecret | undefined> | AiCredentialSecret | undefined;

/**
 * Default decoder: bare `apiKey`, the `plaintext-v1` payload shape, and the
 * `PLAINTEXT` envelope AI Connections writes locally. Wrapped envelopes return
 * `undefined` so a caller with a credential vault can decode them.
 */
export const defaultAiCredentialSecretDecoder: AiCredentialSecretDecoder = (row) =>
  decodePlaintextAiCredentialSecret(row);

export function decodePlaintextAiCredentialSecret(row: Record<string, unknown>): AiCredentialSecret | undefined {
  const apiKey = stringValue(row.apiKey);
  if (apiKey) {
    return { ...apiKeySecret(row), apiKey };
  }
  const payload = decodePlaintextPayload(row);
  if (payload) {
    return payload;
  }
  return decodePlaintextEnvelope(row.encryptedSecret, row.secretPayload);
}

/** The `plaintext-v1` storage shape: a JSON `secretPayload` column. */
function decodePlaintextPayload(row: Record<string, unknown>): AiCredentialSecret | undefined {
  const storageMode = stringValue(row.storageMode);
  const secretPayload = stringValue(row.secretPayload);
  if (storageMode !== 'plaintext-v1' || !secretPayload) {
    return undefined;
  }
  return parseSecretObject(secretPayload);
}

/** The `encryptedSecret` envelope shape used by AI Connections. */
function decodePlaintextEnvelope(encryptedSecret: unknown, secretPayload: unknown): AiCredentialSecret | undefined {
  const envelope = parseEnvelope(encryptedSecret) ?? parseEnvelope(secretPayload);
  if (!envelope) {
    return undefined;
  }
  const algorithm = stringValue(envelope.algorithm);
  if (algorithm !== PLAINTEXT_CREDENTIAL_ALGORITHM) {
    return undefined;
  }
  const ciphertext = stringValue(envelope.ciphertext);
  if (!ciphertext) {
    return undefined;
  }
  if (stringValue(envelope.encoding) === 'base64') {
    try {
      return parseSecretObject(Buffer.from(ciphertext, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  }
  return parseSecretObject(ciphertext);
}

export function parseCredentialEnvelope(value: unknown): Record<string, unknown> | undefined {
  return parseEnvelope(value);
}

function parseEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const serialized = stringValue(value);
  if (!serialized) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseSecretObject(serialized: string): AiCredentialSecret | undefined {
  if (!serialized.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as AiCredentialSecret
      : undefined;
  } catch {
    return undefined;
  }
}

/** Token fields a decoded secret may carry instead of `apiKey`. */
export function providerTokenFromSecret(secret: AiCredentialSecret | undefined): string | undefined {
  if (!secret) {
    return undefined;
  }
  return stringValue(secret.apiKey)
    ?? stringValue(secret.accessToken)
    ?? stringValue(secret.token);
}

function apiKeySecret(row: Record<string, unknown>): AiCredentialSecret {
  const accessToken = stringValue(row.accessToken);
  return accessToken ? { accessToken } : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
