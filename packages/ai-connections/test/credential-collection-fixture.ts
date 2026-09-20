import { credentialDescriptor, credentialResource } from '@undefineds.co/models'
import { definePodCollection, podCollectionInternals } from '@undefineds.co/pod-collections'
import type { PodCollection, PodSyncState } from '@undefineds.co/pod-collections'
import type { SolidDatabase } from '@undefineds.co/drizzle-solid'
import type {
  AiConnectionsPodStore,
  PodCollectionHostRequest,
  PodCollectionsCapability,
  PodModelDescriptor,
} from '@undefineds.co/extension-sdk/web'
import type { RowOf } from '@undefineds.co/pod-collections'
import {
  credentialOfferingMetadata,
  defaultOfferingFor,
  offeringBaseUrl,
  storedOfferingIdFor,
} from '../src/provider-catalog'
import { normalizeProxyUrl } from '../src/client/normalize'
import type { AiProviderCredentialSummary, AiProviderSummary } from '../src'

/**
 * A host that offers a *real* credentials collection over a fake Pod database:
 * no network, no CSS, but the genuine models descriptor, the genuine collection
 * layer and the genuine TanStack collection underneath the page.
 *
 * That is the point of these tests: a fake collection would let the page pass
 * while the real one never confirmed a write. What is faked here is only the
 * I/O - the drizzle database, the notification socket and the Pod store - and
 * each of them records what it was asked to do.
 */

export const POD_URL = 'https://pod.example/alice/'
export const CREDENTIALS_DOCUMENT = `${POD_URL}settings/credentials.ttl`
export const WEB_ID = 'https://pod.example/alice/profile/card#me'

export type CredentialCollectionRow = RowOf<typeof credentialDescriptor>

export interface FakeWriteCall {
  values?: Record<string, unknown>
  id?: string
  changes?: Record<string, unknown>
}

export interface CredentialCollectionFixture {
  capability: PodCollectionsCapability
  store: AiConnectionsPodStore
  /** Provider summaries the store reports; also the enrichment carrier of the page. */
  setProviderProducts(products: AiProviderSummary[]): void
  /** The collection the applet declared through this capability. */
  collection(): PodCollection<CredentialCollectionRow> | undefined
  syncState(): PodSyncState
  /** Writes stay in flight until `releaseWrites()` (the optimistic window). */
  holdWrites(): void
  releaseWrites(): void
  /** The next write is rejected by the "server". */
  failNextWrite(error?: Error): void
  /** A dirty signal on the credentials document (a foreign write, or our own echo). */
  signal(times?: number): void
  /** Columns the store owns; written straight into the document, as the store does. */
  applyStoreColumns(key: string, columns: Record<string, unknown>): void
  documentRow(key: string): Record<string, unknown> | undefined
  calls: {
    select: number
    insert: FakeWriteCall[]
    updateById: FakeWriteCall[]
    deleteById: FakeWriteCall[]
    storeCreate: Array<{ provider: string; input: Record<string, unknown> }>
    storeUpdate: Array<{ provider: string; credentialId: string; input: Record<string, unknown> }>
  }
}

export interface CredentialCollectionFixtureOptions {
  /** Document rows by collection key, in drizzle column names. */
  rows?: Record<string, Record<string, unknown>>
  products?: AiProviderSummary[]
  coalesceMs?: number
}

/** A credential row as the Pod document holds it, in table column names. */
export function credentialDocumentRow(patch: Partial<{
  provider: string
  authMode: string
  status: string
  label: string
  accountLabel: string
  keyVersion: string
  reauthRequired: boolean
  encryptionAlgorithm: string
  encryptedSecret: string
  offeringId: string
  baseUrl: string
}> = {}): Record<string, unknown> {
  return {
    service: 'ai',
    provider: 'openai.ttl',
    authMode: 'apiKey',
    status: 'active',
    label: 'Primary key',
    accountLabel: 'Primary key',
    keyVersion: '1',
    reauthRequired: false,
    encryptionAlgorithm: 'PLAINTEXT',
    encryptedSecret: JSON.stringify({ algorithm: 'PLAINTEXT', ciphertext: 'e30=' }),
    ...patch,
  }
}

export function credentialSummary(
  patch: Partial<AiProviderCredentialSummary> = {},
): AiProviderCredentialSummary {
  return {
    id: credentialResource.buildId({ id: 'openai-1' }),
    provider: 'openai',
    offeringId: 'api-platform',
    authMode: 'apiKey',
    label: 'Primary key',
    enabled: true,
    priority: 10,
    health: 'healthy',
    maskedHint: 'sk-...1234',
    version: 1,
    ...patch,
  }
}

export function createCredentialCollectionFixture(
  options: CredentialCollectionFixtureOptions = {},
): CredentialCollectionFixture {
  const rows = new Map<string, Record<string, unknown>>(Object.entries(options.rows ?? {}))
  let products: AiProviderSummary[] = options.products ?? []
  let gate: { promise: Promise<void>; release: () => void } | undefined
  let nextWriteError: Error | undefined
  let defined: PodCollection<CredentialCollectionRow> | undefined
  const listeners = new Set<(signal: { topic: string }) => void>()
  const watched: string[] = []
  const calls: CredentialCollectionFixture['calls'] = {
    select: 0,
    insert: [],
    updateById: [],
    deleteById: [],
    storeCreate: [],
    storeUpdate: [],
  }

  const resourceIdOf = (key: string): string => credentialResource.buildId({ id: key })
  const keyOfResourceId = (resourceId: string): string => {
    const hash = resourceId.indexOf('#')
    return hash < 0 ? resourceId : resourceId.slice(hash + 1)
  }
  const materialize = (key: string, values: Record<string, unknown>): Record<string, unknown> => {
    const iri = `${CREDENTIALS_DOCUMENT}#${key}`
    return { id: resourceIdOf(key), '@id': iri, uri: iri, subject: iri, ...values }
  }
  const passGate = async (): Promise<void> => {
    const current = gate
    if (current) await current.promise
  }
  const failIfArmed = (): void => {
    const error = nextWriteError
    nextWriteError = undefined
    if (error) throw error
  }

  const database = {
    async init() {},
    select() {
      return {
        from() {
          return {
            async execute() {
              calls.select += 1
              return [...rows.entries()].map(([key, values]) => materialize(key, values))
            },
          }
        },
      }
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          return {
            async execute() {
              // Recorded before the gate: the call has been issued, which is
              // what the assertions about in-flight writes are about.
              calls.insert.push({ values: { ...values } })
              await passGate()
              failIfArmed()
              const stored = { ...values }
              delete stored.id
              rows.set(keyOfResourceId(String(values.id)), stored)
              return [values]
            },
          }
        },
      }
    },
    async updateById(_table: unknown, id: string, changes: Record<string, unknown>) {
      calls.updateById.push({ id, changes: { ...changes } })
      await passGate()
      failIfArmed()
      const key = keyOfResourceId(id)
      const next = { ...rows.get(key), ...changes }
      rows.set(key, next)
      return materialize(key, next)
    },
    async deleteById(_table: unknown, id: string) {
      calls.deleteById.push({ id })
      await passGate()
      failIfArmed()
      const key = keyOfResourceId(id)
      const existed = rows.delete(key)
      return existed
    },
  }

  const feed = {
    watch(topicUrl: string, listener: (signal: { topic: string }) => void) {
      watched.push(topicUrl)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getState: () => 'idle' as const,
    subscribeState: () => () => undefined,
  }

  const capability: PodCollectionsCapability = {
    define<D extends PodModelDescriptor>(
      descriptor: D,
      request: PodCollectionHostRequest<D>,
    ): PodCollection<RowOf<D>> {
      const collection = definePodCollection(descriptor, {
        ...request,
        database: database as unknown as SolidDatabase,
        podUrl: POD_URL,
        feed,
        coalesceMs: options.coalesceMs ?? 5,
      })
      defined = collection as unknown as PodCollection<CredentialCollectionRow>
      return collection
    },
    syncState: (collection) => podCollectionInternals(collection).syncState(),
    subscribeSyncState: () => () => undefined,
    dispose: () => undefined,
  }

  const store: AiConnectionsPodStore = {
    async listProviders() {
      return products
    },
    credentialsTableDocument: () => CREDENTIALS_DOCUMENT,
    providerTableDocument: (provider: string) => `${POD_URL}settings/providers/${provider}.ttl`,
    async listModels() {
      return []
    },
    async createApiKeyCredential(provider, input) {
      calls.storeCreate.push({ provider, input: { ...input } as Record<string, unknown> })
      const id = String((input as { id?: string }).id ?? credentialResource.buildId({ id: `${provider}-2` }))
      // The store completes the same row the collection created. It derives the
      // offering columns with the shared helpers, because a read has to project
      // exactly what the writer wrote - otherwise our own confirmation looks
      // like a change.
      const key = keyOfResourceId(id)
      const offeringId = storedOfferingIdFor(provider, input.offeringId ?? defaultOfferingFor(provider, 'apiKey'))
      const baseUrl = input.baseUrl ?? offeringBaseUrl(provider, offeringId)
      const proxyUrl = normalizeProxyUrl(input.proxyUrl)
      const next = {
        ...rows.get(key),
        offeringId,
        ...(baseUrl ? { baseUrl } : {}),
        ...(proxyUrl ? { proxyUrl } : {}),
        encryptedSecret: JSON.stringify({
          algorithm: 'PLAINTEXT',
          credentialIri: `${CREDENTIALS_DOCUMENT}#${key}`,
          provider,
        }),
        metadata: credentialOfferingMetadata({ offeringId, baseUrl, priority: input.priority }),
      }
      rows.set(key, next)
      return credentialSummary({
        id,
        provider: provider as AiProviderCredentialSummary['provider'],
        offeringId: String(next.offeringId),
        label: input.label,
        baseUrl: input.baseUrl,
      })
    },
    async updateProviderCredential(provider, credentialId, input) {
      calls.storeUpdate.push({ provider, credentialId, input: { ...input } })
      const key = keyOfResourceId(credentialId)
      const next = { ...rows.get(key), ...(input.enabled === undefined ? {} : { status: input.enabled ? 'active' : 'disabled' }) }
      rows.set(key, next)
      return credentialSummary({
        id: credentialId,
        provider: provider as AiProviderCredentialSummary['provider'],
        enabled: input.enabled ?? true,
        priority: input.priority ?? 10,
        version: (input.expectedVersion ?? 1) + 1,
      })
    },
  }

  return {
    capability,
    store,
    setProviderProducts: (next) => {
      products = next
    },
    collection: () => defined,
    syncState: () => (defined ? podCollectionInternals(defined).syncState() : 'initializing'),
    holdWrites: () => {
      if (gate) return
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gate = { promise, release }
    },
    releaseWrites: () => {
      const current = gate
      gate = undefined
      current?.release()
    },
    failNextWrite: (error) => {
      nextWriteError = error ?? new Error('fake_server_rejected')
    },
    signal: (times = 1) => {
      for (let index = 0; index < times; index += 1) {
        for (const listener of [...listeners]) listener({ topic: CREDENTIALS_DOCUMENT })
      }
    },
    applyStoreColumns: (key, columns) => {
      rows.set(key, { ...rows.get(key), ...columns })
    },
    documentRow: (key) => rows.get(key),
    calls,
  }
}
