/**
 * Carries an identity's sealed key set through its own Pod.
 *
 * The custody decision is that the private key is ciphertext inside that identity's
 * Pod, read and written through the Pod API. `signingKeyStore.ts` owns the sealing;
 * this file owns the transport: one `credential` row of the identity's Pod whose
 * `secretPayload` is the secret-cell envelope, plus the wire-up to a Pod-backed
 * drizzle database.
 *
 * The row is descriptive as well as opaque: `service: 'matrix'`, the server name and
 * the envelope's own key id are readable so an operator can tell what a credential is
 * for and rotate it, while the envelope stays the single source of truth for the
 * bytes. Nothing here ever sees the plaintext key.
 */
import { credentialResource } from '@undefineds.co/models';
import { drizzle } from '@undefineds.co/drizzle-solid';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { MatrixSigningKeySet } from './protocol/signingKeys';
import type { SealedSecretChannel } from './signingKeyStore';

/** The credential columns the channel reads and writes. */
export interface MatrixSigningKeyRow {
  id: string;
  secretPayload?: string | null;
}

/** The database surface the channel needs; `createPodSigningKeyDb` provides it. */
export interface MatrixSigningKeyChannelDb {
  findById<T>(resource: unknown, id: string, options?: unknown): Promise<T | null | undefined>;
  insert(resource: unknown): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } };
  updateById(resource: unknown, id: string, value: Record<string, unknown>): Promise<unknown>;
}

/** A stable, readable locator per signing identity. */
export function matrixSigningKeyLocator(serverName: string): string {
  if (!serverName.trim()) throw new Error('A Matrix signing key needs a server name');
  return `matrix-signing-${serverName}`;
}

/** The sealed key set travels in the credentials document of the identity's own Pod. */
export function matrixSigningKeyStorageId(serverName: string): string {
  return credentialResource.buildId({ id: matrixSigningKeyLocator(serverName) });
}

export function createPodSigningKeyChannel(options: {
  db: MatrixSigningKeyChannelDb;
  serverName: string;
  now?: () => number;
}): SealedSecretChannel {
  const id = matrixSigningKeyStorageId(options.serverName);
  const now = options.now ?? Date.now;
  return {
    async read(): Promise<string | undefined> {
      const row = await options.db.findById<MatrixSigningKeyRow>(credentialResource, id);
      const payload = row?.secretPayload;
      return typeof payload === 'string' && payload.length > 0 ? payload : undefined;
    },
    async write(payload: string): Promise<void> {
      const fields = credentialFields(options.serverName, payload, now);
      const existing = await options.db.findById<MatrixSigningKeyRow>(credentialResource, id);
      if (existing) {
        await options.db.updateById(credentialResource, id, fields);
        return;
      }
      await options.db.insert(credentialResource).values({ id, ...fields }).execute();
    },
  };
}

/**
 * A drizzle database bound to the Pod of one identity.
 *
 * The fetch must already carry that identity's authorization: the key belongs to the
 * identity, so only its own Pod may hold it.
 */
export async function createPodSigningKeyDb(input: {
  podAccess: PodAccessFetchProvider;
  /** WebID of the identity whose Pod holds the key. */
  owner: string;
  podUrl: string;
  context?: Parameters<PodAccessFetchProvider['getPodFetch']>[1];
}): Promise<MatrixSigningKeyChannelDb> {
  const fetch = await input.podAccess.getPodFetch(input.owner, input.context);
  if (!fetch) {
    throw new Error(`No Pod access for ${input.owner}; the Matrix signing key cannot be read or written`);
  }
  return drizzle(
    {
      fetch,
      info: { webId: input.owner, podUrl: input.podUrl, isLoggedIn: true },
    } as never,
    {
      podUrl: input.podUrl,
      resourcePreparation: 'off',
      schema: { credential: credentialResource },
    } as never,
  ) as unknown as MatrixSigningKeyChannelDb;
}

/**
 * Descriptive columns beside the envelope. They say what the credential is and which
 * key id sealed it; they never carry the key itself.
 */
function credentialFields(serverName: string, payload: string, now: () => number): Record<string, unknown> {
  return {
    service: 'matrix',
    label: `Matrix signing key for ${serverName}`,
    status: 'active',
    storageMode: 'secret-cell-v1',
    encryptionAlgorithm: envelopeAlgorithm(payload),
    keyVersion: envelopeKeyId(payload),
    secretPayload: payload,
    updatedAt: new Date(now()).toISOString(),
  };
}

function envelopeAlgorithm(payload: string): string | undefined {
  return envelopeField(payload, 'algorithm');
}

function envelopeKeyId(payload: string): string | undefined {
  const wrapped = envelopeField(payload, 'wrappedDek');
  if (wrapped !== undefined) return wrapped;
  return envelopeField(payload, 'keyId');
}

/**
 * Read one field of the envelope for the descriptive columns only. A payload that is
 * not an envelope is stored as-is: the store that seals it is the one that reports a
 * malformed payload, and this layer must not start rejecting what it cannot parse.
 */
function envelopeField(payload: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const value = field === 'wrappedDek' ? (parsed.wrappedDek as Record<string, unknown> | undefined)?.keyId : parsed[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
