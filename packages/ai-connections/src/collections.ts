import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import type { PodCollection, RowOf } from '@undefineds.co/pod-collections'
import { useSyncExternalStore } from 'react'
import type {
  AiConnectionsProvider,
  AiProviderCredentialSummary,
  AiProviderSummary,
} from './ai-connections-client'
import { AI_CONNECTIONS_PROVIDERS } from './ai-connections-client'
import { defaultOfferingFor } from './provider-catalog'
import { providerOfCredentialKey, providerResourceKey } from './credential-storage'

/**
 * The credentials table, declared once (`docs/pod-collections.md` §6.4-2).
 *
 * This module is the *shape* of the table and everything that can be computed
 * from a row without the collection layer: the row type, the projection of a row
 * into the summary the page renders, and the enrichment carriers. Nothing here
 * imports `@undefineds.co/pod-collections` at runtime - the row type is a type,
 * and the two things that do need the layer (declaring the table, reading and
 * writing its rows) live in `./collection-runtime`, which is reached through the
 * dynamic import below. That is what keeps the engine out of the settings
 * entry's chunk and out of any page that renders without live rows (§9-9).
 *
 * The one read the page does here, `useCredentialRows`, is a `useSyncExternalStore`
 * subscription to a rows source (the controller's live snapshot of the
 * collection). It is deliberately not `@tanstack/react-db`'s `useLiveQuery`: the
 * page needs "all rows of one table, once its first read landed", which the
 * collection's own change feed answers, and loading a hook lazily would force
 * the whole panel to remount when the chunk arrived. The design doc names this
 * exit explicitly (§7.4-4, §8.7-5: engine only, no react hook).
 *
 * ## What the collection can carry, and what it cannot (yet)
 *
 * Rows are the descriptor's projection: `id`, `service`, `provider`, `label`,
 * `accountLabel`, `authMode`, `status`, `keyVersion`, `expiresAt`,
 * `reauthRequired`, … The known schema drift (locked by
 * `packages/pod-collections/test/guards.test.ts`) means `offeringId`,
 * `metadata`, `baseUrl` and `proxyUrl` are **not** projectable, and `secret`
 * fields are not projected however they are written. So
 *
 * - reading carries the undeclared attributes over from the store's own summary
 *   of the same row (`credentialCarriers`), and
 * - writing hands them to the store (`AiConnectionsPodStore`), which owns those
 *   columns and the secret envelope.
 *
 * Both are migration-window behaviour. models 0.2.57 now declares all four, so
 * their delete condition is formally met, but they stay until the descriptor
 * projection work (P4) retires the carrier path as a whole - removing them one
 * at a time would leave reads and writes disagreeing in between.
 */

/** A credentials-table row as the collection projects it. */
export type CredentialRow = RowOf<typeof credentialDescriptor>

/** The collection's `syncState` is the page's availability signal. */
export interface CredentialCollection {
  readonly collection: PodCollection<CredentialRow>
}

/**
 * A live rows source: the controller's snapshot of the credentials collection.
 *
 * `credentialRows` is `undefined` until the collection's first read lands - and
 * stays `undefined` while the collection layer is still loading, when the host
 * offers no `podCollections` capability, or after a failed first read. The page
 * keeps its store-backed rendering in every one of those states.
 */
export interface CredentialRowsSource {
  subscribe(listener: () => void): () => void
  readonly credentialRows?: readonly CredentialRow[]
}

/**
 * Live rows for the credentials table. Re-renders on sync and on optimistic
 * writes, because the source is the collection's own change feed.
 */
export function useCredentialRows(source: CredentialRowsSource): readonly CredentialRow[] | undefined {
  return useSyncExternalStore(
    source.subscribe,
    () => source.credentialRows,
    () => source.credentialRows,
  )
}

/** The lazy half of this module's subject: everything that needs the engine. */
export type CredentialCollectionRuntime = typeof import('./collection-runtime')

let runtime: Promise<CredentialCollectionRuntime> | undefined

/**
 * The collection layer at the point of use, fetched once.
 *
 * This is the applet's only dynamic import of it: the settings entry and the
 * applet's own chunk contain no part of the engine, and a page that never
 * reaches the credentials list never fetches it.
 */
export function credentialCollectionRuntime(): Promise<CredentialCollectionRuntime> {
  runtime ??= import('./collection-runtime')
  return runtime
}

/**
 * The row's resource id in the shape the rest of the applet uses for
 * credentials: `credentials.ttl#<key>`. The collection's key is only the
 * `resourceIdPattern` slot (`#{id}` → `openai-<uuid>`), so the document segment
 * comes from the same models builder the store writes with.
 */
export function credentialIdOfRow(row: CredentialRow): string {
  return credentialResource.buildId({ id: String(row.id) })
}

/**
 * Which provider a row belongs to, from the row's own `provider` relation.
 *
 * Rows have to be attributable without the store's help: a credential another
 * device just wrote reaches this page as a live row, before any summary read
 * has seen it.
 */
export function providerOfCredentialRow(row: CredentialRow): AiConnectionsProvider | undefined {
  // `RowOf` carries an index signature (models types `fields` as
  // `Record<string, PodModelFieldDescriptor>`), so a stale attribute name
  // type-checks and reads back `undefined` at runtime instead of failing the
  // build. `collections.test.ts` pins this read against a row whose id does not
  // embed its provider, which is the only case the fallback below cannot answer.
  const relation = typeof row.provider === 'string' ? row.provider : undefined
  const key = providerResourceKey(relation)
  if (key) {
    if (key.startsWith('custom-instance-')) return 'custom'
    const declared = AI_CONNECTIONS_PROVIDERS.find(
      (provider) => key === provider || key.startsWith(`${provider}-`),
    )
    if (declared) return declared
  }
  // A row without a provider relation still declares one in its own key
  // (`openai-<uuid>`); the store's reader falls back the same way.
  return providerOfCredentialKey(String(row.id)) as AiConnectionsProvider | undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isoStringValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString()
  return stringValue(value)
}

function authModeValue(value: unknown): AiProviderCredentialSummary['authMode'] | undefined {
  if (value === 'oauth' || value === 'deviceCode' || value === 'apiKey' || value === 'local') {
    return value
  }
  if (value === 'deviceCodeOAuth') return 'deviceCode'
  return undefined
}

/**
 * A row as the page's credential summary.
 *
 * The row wins for everything the descriptor declares; `carrier` - the store's
 * summary of the same credential - supplies the attributes the descriptor cannot
 * project and the secret-derived hint. A row the store has not read yet (an
 * optimistic insert) falls back to the descriptor's own defaults.
 */
export function credentialSummaryFromRow(
  row: CredentialRow,
  provider: AiConnectionsProvider,
  carrier?: AiProviderCredentialSummary,
): AiProviderCredentialSummary {
  const authMode = authModeValue(row.authMode) ?? carrier?.authMode ?? 'apiKey'
  const status = stringValue(row.status)
  // models 0.2.59 types this column as a boolean; a Pod written by an older
  // release can still carry the literal as a string, so keep tolerating both.
  const reauthRequired = row.reauthRequired === true || String(row.reauthRequired) === 'true'
  return {
    id: String(row.id),
    provider,
    offeringId: carrier?.offeringId ?? defaultOfferingFor(provider, authMode),
    authMode,
    label: stringValue(row.accountLabel) ?? stringValue(row.label) ?? carrier?.label,
    enabled: status === undefined ? carrier?.enabled ?? true : status === 'active',
    priority: carrier?.priority ?? 100,
    health: reauthRequired ? 'expired' : carrier?.health ?? 'unknown',
    maskedHint: carrier?.maskedHint,
    baseUrl: carrier?.baseUrl,
    proxyUrl: carrier?.proxyUrl,
    compatibility: carrier?.compatibility,
    expiresAt: isoStringValue(row.expiresAt) ?? carrier?.expiresAt,
    version: numberValue(row.keyVersion) ?? carrier?.version ?? 0,
  }
}

/** The provider's credential list, rebuilt from the live rows of one table document. */
export function credentialSummariesForProvider(
  provider: AiConnectionsProvider,
  rows: readonly CredentialRow[],
  carrier: readonly AiProviderCredentialSummary[] = [],
): AiProviderCredentialSummary[] {
  const byId = new Map(carrier.map((credential) => [credential.id, credential]))
  const summaries: AiProviderCredentialSummary[] = []
  for (const row of rows) {
    if (providerOfCredentialRow(row) !== provider) continue
    summaries.push(credentialSummaryFromRow(row, provider, byId.get(String(row.id))))
  }
  return summaries
}

/**
 * The enrichment carrier per provider: the store's own summary of every
 * credential, plus any credential a mutation of this session added and the store
 * has not read back yet.
 *
 * The store's entries win where both know the same credential - it is the
 * independent read - and the session's overlay only fills the gap, so a
 * just-created row keeps its offering and base URL while it is still optimistic.
 */
export function credentialCarriers(
  storeProducts: Partial<Record<AiConnectionsProvider, AiProviderSummary>>,
  overlayProducts: Partial<Record<AiConnectionsProvider, AiProviderSummary>>,
): Partial<Record<AiConnectionsProvider, readonly AiProviderCredentialSummary[]>> {
  const carriers: Partial<Record<AiConnectionsProvider, readonly AiProviderCredentialSummary[]>> = {}
  for (const provider of AI_CONNECTIONS_PROVIDERS) {
    const byId = new Map<string, AiProviderCredentialSummary>()
    for (const credential of overlayProducts[provider]?.credentials ?? []) {
      byId.set(credential.id, credential)
    }
    for (const credential of storeProducts[provider]?.credentials ?? []) {
      byId.set(credential.id, credential)
    }
    carriers[provider] = [...byId.values()]
  }
  return carriers
}

/**
 * The provider products the page renders, with every credential list rebuilt
 * from the live rows.
 *
 * `carriers` only enriches: which credentials exist, and every field the
 * descriptor declares, come from the rows.
 */
export function withLiveCredentials(
  products: Partial<Record<AiConnectionsProvider, AiProviderSummary>>,
  carriers: Partial<Record<AiConnectionsProvider, readonly AiProviderCredentialSummary[]>>,
  rows: readonly CredentialRow[] | undefined,
): Partial<Record<AiConnectionsProvider, AiProviderSummary>> {
  if (!rows) return products
  const live: Partial<Record<AiConnectionsProvider, AiProviderSummary>> = {}
  for (const provider of AI_CONNECTIONS_PROVIDERS) {
    const product = products[provider]
    if (!product) continue
    live[provider] = {
      ...product,
      credentials: credentialSummariesForProvider(provider, rows, carriers[provider] ?? []),
    }
  }
  // Providers outside the catalog keep whatever the store reported: the page
  // never renders them from this table.
  return { ...products, ...live }
}
