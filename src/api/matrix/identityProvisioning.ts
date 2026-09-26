/**
 * Minting a participant's signing identity.
 *
 * The custody decision says the private key is sealed in that identity's own Pod; the
 * key lifecycle (staged/active/retired) and the Pod transport already exist. What was
 * missing is the trigger: something has to create the first key set and put it there.
 *
 * This module is that trigger, and it is deliberately explicit rather than automatic.
 * *Which* participants a deployment serves as their own server is a deployment policy
 * — and it decides whose events this deployment may sign — so it is not guessed here.
 * The caller hands over a Pod and a server name, and this function is idempotent: an
 * existing key set is read back and never replaced, because replacing it would orphan
 * every signature that identity has already published.
 */
import { credentialResource } from '@undefineds.co/models';
import { UDFS } from '../models/namespaces';
import type { PodAccessFetchProvider, PodAccessRequestContext } from '../ai-gateway/pod/OwnerPodAccess';
import type { SecretCellContext, SecretCellVault } from '../../security/secret-cell';
import { MatrixSigningIdentityProvider, SealedMatrixSigningKeyStore } from './signingKeyStore';
import {
  createPodSigningKeyChannel,
  createPodSigningKeyDb,
  matrixSigningKeyLocator,
  matrixSigningKeyStorageId,
  type MatrixSigningKeyChannelDb,
} from './signingKeyChannel';

export interface ProvisionedMatrixIdentity {
  serverName: string;
  /** The key that now signs for this identity. */
  keyId: string;
  /** The credential row holding the sealed key set, for audit and rotation. */
  storageId: string;
  /** `true` when this call created the key set, `false` when it read an existing one. */
  created: boolean;
}

export interface ProvisionMatrixSigningIdentityInput {
  serverName: string;
  /** WebID of the identity whose Pod holds the key. */
  ownerWebId: string;
  podUrl: string;
  vault: SecretCellVault;
  now?: () => number;
  retentionMs?: number;
  keyRefreshMs?: number;
}

/** Provision into an already-built Pod database. */
export async function provisionMatrixSigningIdentityWithDb(
  input: ProvisionMatrixSigningIdentityInput & { db: MatrixSigningKeyChannelDb },
): Promise<ProvisionedMatrixIdentity> {
  if (!input.serverName.trim()) throw new Error('A Matrix signing identity needs a server name');
  const channel = createPodSigningKeyChannel({ db: input.db, serverName: input.serverName, now: input.now });
  const created = (await channel.read()) === undefined;
  const store = new SealedMatrixSigningKeyStore({
    vault: input.vault,
    context: signingKeySecretContext(input.serverName, input.ownerWebId),
    channel,
  });
  const identity = await new MatrixSigningIdentityProvider({
    store,
    serverName: input.serverName,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }),
    ...(input.keyRefreshMs === undefined ? {} : { keyRefreshMs: input.keyRefreshMs }),
  }).identity();
  return {
    serverName: input.serverName,
    keyId: identity.keyId,
    storageId: matrixSigningKeyStorageId(input.serverName),
    created,
  };
}

/**
 * Provision in the participant's own Pod, using that participant's authorization.
 *
 * A deployment that holds no access to the identity's Pod cannot mint its key, and is
 * refused rather than given somewhere else to put it.
 */
export async function provisionMatrixSigningIdentity(
  input: ProvisionMatrixSigningIdentityInput & {
    podAccess: PodAccessFetchProvider;
    context?: PodAccessRequestContext;
  },
): Promise<ProvisionedMatrixIdentity> {
  const db = await createPodSigningKeyDb({
    podAccess: input.podAccess,
    owner: input.ownerWebId,
    podUrl: input.podUrl,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  return provisionMatrixSigningIdentityWithDb({ ...input, db });
}

/**
 * The secret-cell context the envelope is bound to: this identity's own credential row
 * in this identity's own Pod. Sealing and opening use the same function, so a payload
 * copied to another identity's resource cannot be opened.
 */
export function signingKeySecretContext(serverName: string, ownerWebId: string): SecretCellContext {
  return {
    ownerWebId,
    resourceIri: credentialResource.buildIri(ownerWebId, { id: matrixSigningKeyLocator(serverName) }),
    predicate: UDFS.secretPayload,
    field: 'matrixSigningKeySet',
    schemaVersion: 'v1',
    provider: 'matrix',
  };
}
