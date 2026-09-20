import { normalizeMessagesEndpoint, normalizeV1Endpoint } from '@undefineds.co/ai-connections-core/endpoint-urls'
import type { AiEndpointEntry } from './offering-endpoints'

/**
 * The protocols the Xpod gateway serves, as registered by
 * `src/api/handlers/AiGatewayHandler.ts`:
 *
 * - `POST /v1/chat/completions` (OpenAI Chat Completions)
 * - `POST /v1/responses`        (OpenAI Responses)
 * - `POST /v1/messages`         (Anthropic Messages)
 *
 * Each base URL comes from the same rule the coding-client adapters use, so what
 * this page advertises is exactly what `AiClientConfigurationService` writes into
 * a client.
 */
export function xpodProtocolEndpoints(apiBase: string): AiEndpointEntry[] {
  return [
    { protocol: 'chatCompletions', baseUrl: normalizeV1Endpoint(apiBase) },
    { protocol: 'responses', baseUrl: normalizeV1Endpoint(apiBase) },
    { protocol: 'anthropic', baseUrl: normalizeMessagesEndpoint(apiBase) },
  ]
}
