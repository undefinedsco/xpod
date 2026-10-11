/**
 * The endpoint shape rules every consumer shares: the coding-client adapters
 * (`client-config/base-adapter.ts`) and the UI both point clients at the same
 * Xpod base URL, so the `/v1` rule lives here once and nowhere else.
 *
 * This module must stay dependency-free: it is bundled into the Web applet and
 * imported by the Node-side configuration service.
 */

/** OpenAI-compatible base: the client appends `/chat/completions` or `/responses` itself. */
export function normalizeV1Endpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

/**
 * Anthropic base: `ANTHROPIC_BASE_URL` is the host; the client appends
 * `/v1/messages`, so a trailing `/v1` has to come off rather than stay on.
 */
export function normalizeMessagesEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}
