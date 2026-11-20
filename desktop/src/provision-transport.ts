import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec.js'
import type { DesktopProvisionRequest, DesktopProvisionResponse } from '../../packages/extension-sdk/src/shell-state.js'

const PATHS = new Set(['/provision/pods', '/provision/webids'])

/** Same-device transport only; never an arbitrary URL or privileged-token proxy. */
export async function requestDesktopProvision(
  input: unknown,
  options: { productOrigin: string; issuer: string | undefined; fetchImpl?: typeof fetch },
): Promise<DesktopProvisionResponse> {
  const product = new URL(options.productOrigin)
  if (product.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(product.hostname)
    || product.username || product.password || !options.issuer) throw new Error('Local onboarding transport is unavailable')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Local onboarding request')
  const request = input as Partial<DesktopProvisionRequest>
  if (typeof request.provisionCode !== 'string' || request.provisionCode.length > 32_768
    || !PATHS.has(request.path ?? '') || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new Error('Invalid Local onboarding request')
  }
  const body = JSON.stringify(request.body)
  if (Buffer.byteLength(body) > 65_536) throw new Error('Local onboarding request is too large')
  const scope = new ProvisionCodeCodec(options.issuer).decode(request.provisionCode)
  if (!scope?.nodeId || !scope.spDomain || !scope.serviceAccessToken) throw new Error('Local pairing information is invalid or expired')
  const fetchImpl = options.fetchImpl ?? fetch
  const statusResponse = await fetchImpl(new URL('/provision/status', product), {
    redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  })
  if (!statusResponse.ok) throw new Error('Unable to confirm this Local device')
  const status = await readProvisionJson(statusResponse, 1024 * 1024) as { managed?: unknown; registered?: unknown; oidcIssuer?: unknown; provisionCode?: unknown; publicUrl?: unknown }
  const current = typeof status.provisionCode === 'string'
    ? new ProvisionCodeCodec(options.issuer).decode(status.provisionCode) : undefined
  const storage = `https://${scope.spDomain}/`
  if (status.managed !== true || status.registered !== true || status.oidcIssuer !== new URL(options.issuer).href
    || !current || current.nodeId !== scope.nodeId || current.spDomain !== scope.spDomain
    || status.publicUrl !== storage) throw new Error('Local pairing does not belong to this device')
  const response = await fetchImpl(new URL(request.path!, product), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${scope.serviceAccessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  })
  // Only the existing provisioning JSON crosses the bridge. No local runtime
  // settings, refreshed credentials, cookies, response headers or redirects do.
  return { status: response.status, body: await readProvisionJson(response, 2 * 1024 * 1024) }
}

async function readProvisionJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Local onboarding response is empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('Local onboarding response is too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('Local onboarding response is not JSON') }
}
