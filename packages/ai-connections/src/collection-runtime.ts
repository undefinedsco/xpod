import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import { rowKeyOf, type PodCollection } from '@undefineds.co/pod-collections'
import type {
  AiConnectionsPodStore,
  WebExtensionHost,
} from '@undefineds.co/extension-sdk/web'
import type {
  AiConnectionsClient,
  AiConnectionsProvider,
  AiProviderCredentialSummary,
} from './ai-connections-client'
import {
  credentialProviderRelation,
  credentialRowKeyFor,
  customCredentialProviderRelation,
} from './credential-storage'
import { credentialSummaryFromRow, type CredentialCollection, type CredentialRow } from './collections'

/**
 * The half of the credentials table that needs the collection layer at runtime.
 *
 * This module is reached **only** through `collections.credentialCollectionRuntime()`
 * (a dynamic import): it is the single place in the applet that pulls
 * `@undefineds.co/pod-collections` - and with it the TanStack DB engine - so the
 * settings entry and every page that renders the applet without live rows do not
 * carry that weight (`docs/pod-collections.md` §9-9).
 *
 * Everything here is behind an `await`: defining the table (the host may still be
 * fetching the engine), reading rows and writing rows. The page keeps rendering
 * the store's own summary until it lands, which is exactly how it behaves when
 * the host offers no `podCollections` capability at all.
 */

/**
 * The host's live credentials collection, or `undefined` when the host offers no
 * `podCollections` capability (or cannot lay the table out).
 *
 * A missing capability is a degradation, not an error: the page keeps reading
 * through the store exactly as before. `layout_document_required` cannot happen
 * for this descriptor (its document is derived from `storage.base`) but is
 * handled the same way rather than taking the page down with it.
 *
 * `load()` is the host accessor that works whether the collection engine is
 * already in the host or still arriving; `define()` is the eager host's
 * synchronous path and stays the fallback for a host that does not implement it.
 */
export async function openCredentialCollection(
  host: WebExtensionHost,
): Promise<CredentialCollection | undefined> {
  const capability = host.capabilities.podCollections
  if (!capability) return undefined
  try {
    if (capability.load) {
      return { collection: await capability.load(credentialDescriptor, { table: credentialResource }) }
    }
    return { collection: capability.define(credentialDescriptor, { table: credentialResource }) }
  } catch {
    return undefined
  }
}

/** Inverse of {@link credentialIdOfRow}: collection key for a credential resource id. */
export function credentialRowKey(id: string): string | undefined {
  if (!id.includes('#')) return id
  return rowKeyOf(credentialDescriptor, { id })
}

/** Writes a row the descriptor declares; confirmation is the collection's own protocol. */
async function insertCredentialRow(
  collection: PodCollection<CredentialRow>,
  row: Partial<CredentialRow> & { id: string },
): Promise<void> {
  await collection.insert(row).isPersisted.promise
}

/** Patches the descriptor-declared fields of one row (label, status, …). */
async function updateCredentialRow(
  collection: PodCollection<CredentialRow>,
  key: string,
  patch: Partial<CredentialRow>,
): Promise<void> {
  await collection.update(key, (draft) => {
    Object.assign(draft, patch)
  }).isPersisted.promise
}

async function deleteCredentialRow(
  collection: PodCollection<CredentialRow>,
  key: string,
): Promise<void> {
  await collection.delete(key).isPersisted.promise
}

/** The row fields a new credential writes through the collection. */
interface NewCredentialRowInput {
  provider: AiConnectionsProvider
  authMode: 'apiKey' | 'local'
  accountLabel: string
}

/**
 * The row a create writes through the collection: exactly the columns the
 * models descriptor declares.
 *
 * The secret envelope is deliberately absent, and not because the confirmation
 * protocol could not handle it any more (that defect is fixed: a write intent
 * carrying a `secret: true` field now confirms, §9-7). It is absent because the
 * store owns it: `encryptedSecret` is built by the store's encryption path.
 *
 * `offeringId` / `metadata` / `baseUrl` / `proxyUrl` are a different case: models
 * 0.2.57 **does** declare them, so a read projects them back and this row has to
 * carry the same values the store writes or our own echo looks like a change and
 * replaces the row (see `credentials collection` in
 * `packages/ai-connections/test/pod-collections.test.tsx`). Their derivation
 * currently lives in the store adapter, which is why this row still omits them;
 * reconciling that is the open item, not a decision this comment can settle.
 */
function newCredentialRow(
  key: string,
  input: NewCredentialRowInput,
): Partial<CredentialRow> & { id: string } {
  const { provider } = input
  return {
    id: key,
    service: 'ai',
    // The credential descriptor's provider relation (models 0.2.57 names the
    // field `provider`; the retired `providerId` still compiles because `RowOf`
    // carries an index signature, and read back `undefined` at runtime).
    provider: provider === 'custom'
      ? customCredentialProviderRelation(key)
      : credentialProviderRelation(provider),
    authMode: input.authMode,
    status: 'active',
    accountLabel: input.accountLabel,
    label: input.accountLabel,
    keyVersion: '1',
    reauthRequired: false,
    encryptionAlgorithm: 'PLAINTEXT',
  }
}

/**
 * The credential mutations of `AiConnectionsClient`, backed by the collection.
 *
 * Everything the descriptor declares is written through `insert` / `update` /
 * `delete`, so it is optimistic, rolls back on rejection and reconciles with the
 * document instead of being overwritten by the next read. Everything it cannot
 * express - the secret envelope, `offeringId`, `metadata`, base URLs,
 * `compatibility` - is written by the store within the same user action; if that
 * completion fails, the row the collection created is deleted again and a
 * partially applied update is put back, so a failed write leaves no
 * half-written credential behind.
 */
export function collectionCredentialMutations(
  credentials: CredentialCollection,
  store: AiConnectionsPodStore,
): Pick<
  AiConnectionsClient,
  'createApiKeyCredential' | 'createLocalCredential' | 'updateProviderCredential' | 'deleteProviderCredential'
> {
  const { collection } = credentials

  const discard = async (key: string): Promise<void> => {
    await deleteCredentialRow(collection, key).catch(() => undefined)
  }

  const summaryOf = (key: string, provider: AiConnectionsProvider): AiProviderCredentialSummary | undefined => {
    const row = collection.get(key) as CredentialRow | undefined
    return row ? credentialSummaryFromRow(row, provider) : undefined
  }

  const create = async (
    provider: AiConnectionsProvider,
    key: string,
    row: Partial<CredentialRow> & { id: string },
    complete: (id: string) => Promise<unknown>,
  ): Promise<AiProviderCredentialSummary> => {
    await insertCredentialRow(collection, row)
    try {
      const completed = await complete(credentialResource.buildId({ id: key })) as
        | AiProviderCredentialSummary
        | undefined
      const summary = completed ?? summaryOf(key, provider)
      if (!summary) throw new Error('credential_create_failed')
      return summary
    } catch (error) {
      await discard(key)
      throw error
    }
  }

  return {
    async createApiKeyCredential(provider, input) {
      if (!store.createApiKeyCredential) throw new Error('credential_store_unavailable')
      const key = credentialRowKeyFor(provider, 'apiKey')
      const label = input.label ?? provider
      return await create(
        provider,
        key,
        newCredentialRow(key, { provider, authMode: 'apiKey', accountLabel: label }),
        (id) => store.createApiKeyCredential!(provider, { ...input, label, id }),
      )
    },

    async createLocalCredential(provider, input) {
      if (!store.createLocalCredential) throw new Error('credential_store_unavailable')
      const key = credentialRowKeyFor(provider, 'local')
      const label = input.label ?? 'Local'
      return await create(
        provider,
        key,
        newCredentialRow(key, { provider, authMode: 'local', accountLabel: label }),
        (id) => store.createLocalCredential!(provider, { ...input, label, id }),
      )
    },

    async updateProviderCredential(provider, credentialId, input) {
      const key = credentialRowKey(credentialId)
      if (!key) throw new Error('credential_not_found')
      // `label` and `enabled` are descriptor fields: they land optimistically
      // through the collection. Priority and base URLs are not, so they go to
      // the store within the same call.
      const patch: Partial<CredentialRow> = {}
      if (input.label !== undefined) {
        patch.label = input.label
        patch.accountLabel = input.label
      }
      if (input.enabled !== undefined) patch.status = input.enabled ? 'active' : 'disabled'
      const before = collection.get(key) as CredentialRow | undefined
      if (Object.keys(patch).length > 0) await updateCredentialRow(collection, key, patch)

      const attributes = {
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.proxyUrl === undefined ? {} : { proxyUrl: input.proxyUrl }),
      }
      if (Object.keys(attributes).length === 0) return summaryOf(key, provider)!
      if (!store.updateProviderCredential) throw new Error('credential_store_unavailable')

      try {
        const completed = await store.updateProviderCredential(provider, credentialId, {
          expectedVersion: input.expectedVersion,
          ...attributes,
        }) as AiProviderCredentialSummary | undefined
        return completed ?? summaryOf(key, provider)!
      } catch (error) {
        // The optimistic part must not survive a rejected completion: put the
        // row's own fields back, then report the failure.
        if (before && Object.keys(patch).length > 0) {
          await updateCredentialRow(collection, key, {
            ...(patch.label === undefined ? {} : {
              label: before.label as string | undefined,
              accountLabel: before.accountLabel as string | undefined,
            }),
            ...(patch.status === undefined ? {} : { status: before.status as string | undefined }),
          }).catch(() => undefined)
        }
        throw error
      }
    },

    async deleteProviderCredential(provider, credentialId) {
      const key = credentialRowKey(credentialId)
      if (!key) return undefined
      const before = summaryOf(key, provider)
      await deleteCredentialRow(collection, key)
      return before
    },
  }
}
