import { aiProviderResource } from '@undefineds.co/models'
import { AI_CONNECTIONS_PROVIDERS } from './client/types'

/**
 * Storage-shape rules for AI credential rows: the secret envelope, the provider
 * relation a credential declares, and the provider resource key.
 *
 * They live in the capability package, not in the Pod adapter that happens to
 * use them: `@undefineds.co/ai-connections` owns what a credential row looks
 * like, and `ui/src/extensions/XpodAiConnectionsPodStore.ts` is one adapter over
 * it. Keeping one copy is what lets the collection layer write the same rows the
 * adapter reads - a second copy would drift on the first format change.
 */

/** Base64 of the UTF-8 JSON, so the envelope stays a single string literal. */
function encodeBase64Json(value: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64Json(value: string): unknown {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export interface CredentialSecretEnvelopeInput {
  webId: string
  provider: string
  /** The credential's resource IRI (`credentialResource.buildIri(podUrl, { id })`). */
  credentialIri: string
  secret: Record<string, unknown>
}

/**
 * The `encryptedSecret` payload for a credential row.
 *
 * `PLAINTEXT` means "not encrypted at rest yet", not "no envelope": the read
 * side verifies the envelope's owner (`webId`), provider and credential IRI
 * before handing the secret to a provider request, so a row copied between
 * credentials (or between accounts) never yields a usable secret.
 */
export function credentialSecretEnvelope(input: CredentialSecretEnvelopeInput): string {
  return JSON.stringify({
    algorithm: 'PLAINTEXT',
    encoding: 'base64',
    ciphertext: encodeBase64Json(input.secret),
    webId: input.webId,
    credentialIri: input.credentialIri,
    provider: input.provider,
  })
}

export interface CredentialSecretReadInput {
  webId: string
  provider: string
  credentialIri: string
  envelope: unknown
}

/** `undefined` unless the envelope belongs to this account, provider and credential. */
export function decodeCredentialSecret(input: CredentialSecretReadInput): Record<string, unknown> | undefined {
  if (typeof input.envelope !== 'string' || !input.envelope.trim()) return undefined
  try {
    const envelope = JSON.parse(input.envelope) as Record<string, unknown>
    if (envelope.algorithm !== 'PLAINTEXT'
      || envelope.webId !== input.webId
      || envelope.provider !== input.provider
      || envelope.credentialIri !== input.credentialIri) {
      return undefined
    }
    const secret = envelope.encoding === 'base64'
      ? decodeBase64Json(String(envelope.ciphertext))
      : JSON.parse(String(envelope.ciphertext))
    return typeof secret === 'object' && secret !== null && !Array.isArray(secret)
      ? secret as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The provider relation a catalog credential declares (`provider`):
 * `providers/openai.ttl` in resource terms, `openai.ttl` as the stored value.
 *
 * A custom instance owns its own provider document, so there the relation is
 * derived from the credential's own id.
 */
export function credentialProviderRelation(provider: string): string {
  return aiProviderResource.buildId({ id: provider })
}

export function customCredentialProviderRelation(credentialId: string): string {
  return aiProviderResource.buildId({ id: `custom-instance-${encodeURIComponent(credentialId)}.ttl#this` })
}

/**
 * The row key of a new credential: the `{id}` slot of the descriptor's
 * `resourceIdPattern`, which is the credential's identity (never a display
 * name).
 *
 * Two writers create credential rows - `XpodAiConnectionsPodStore` for a plain
 * page, and the collection layer when a live collection creates the row
 * optimistically - and a row key that differed between them would produce two
 * credentials where the user asked for one, so the shape is declared once here.
 */
export function credentialRowKeyFor(provider: string, authMode: 'apiKey' | 'local'): string {
  const suffix = crypto.randomUUID()
  return authMode === 'local' ? `${provider}-local-${suffix}` : `${provider}-${suffix}`
}

/**
 * The provider a credential row key declares, for rows whose `provider` relation
 * is missing: a credential is keyed `<provider>-<uuid>` (see
 * {@link credentialRowKeyFor}), and a custom instance is keyed `custom-…`.
 *
 * A key reaches us in either of two shapes - the bare `resourceIdPattern` slot
 * (`openai-<uuid>`) or a full resource id (`custom-instance-abc.ttl#this`). The
 * provider lives in the document segment in both, never in the fragment, so the
 * fragment must not be the part that gets inspected.
 */
export function providerOfCredentialKey(key: string): string | undefined {
  const document = (key.split('#', 1)[0] ?? key).split('/').filter(Boolean).at(-1) ?? ''
  const name = document.endsWith('.ttl') ? document.slice(0, -'.ttl'.length) : document
  if (!name) return undefined
  if (name.startsWith('custom-') || name === 'custom') return 'custom'
  return AI_CONNECTIONS_PROVIDERS.find(
    (provider) => name === provider || name.startsWith(`${provider}-`),
  )
}

/** `providers/openai.ttl#this` → `openai.ttl#this` (document-relative reference). */
export function providerResourceReference(value: string | undefined): string | undefined {
  if (!value) return undefined
  const withoutFragment = value.split('#', 1)[0] ?? value
  const fileName = withoutFragment.split('/').filter(Boolean).at(-1) ?? withoutFragment
  if (!fileName) return undefined
  const document = fileName.endsWith('.ttl') ? fileName : `${fileName}.ttl`
  const fragmentIndex = value.indexOf('#')
  return fragmentIndex < 0 ? document : `${document}${value.slice(fragmentIndex)}`
}

/** `providers/openai.ttl#this` → `openai` (the document name minus `.ttl`). */
export function providerResourceKey(value: string | undefined): string | undefined {
  const reference = providerResourceReference(value)
  if (!reference) return undefined
  return (reference.split('#', 1)[0] ?? reference).replace(/\.ttl$/u, '')
}
