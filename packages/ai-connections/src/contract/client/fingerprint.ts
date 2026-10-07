/**
 * The digest a client-config adapter computes over the `sk-` wrapper when it
 * records an applied AI Connection (see `contract/client-config/base-adapter.ts`
 * `contentHash(profileApiKey(profile))`). The browser cannot reach that Node
 * helper, so this side must produce the byte-identical SHA-256 hex through the
 * WebCrypto API; the UI compares what the host reports against this value.
 *
 * When the runtime exposes no WebCrypto (older test shims), the digest is
 * honestly unavailable: callers must not fabricate one.
 */
interface SubtleCryptoLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
}

export async function apiKeyFingerprint(apiKey: string): Promise<string | undefined> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCryptoLike } }).crypto?.subtle
  if (!subtle) return undefined
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(apiKey))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
