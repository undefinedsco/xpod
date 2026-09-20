import type { AiProviderOffering } from '@undefineds.co/ai-connections-core/client'

/** One protocol the user can point a client at: the `protocol → base URL` pair the UI lists. */
export interface AiEndpointEntry {
  protocol: string
  baseUrl: string
}

/** Endpoint the offering actually talks to: the discovery protocol wins, first endpoint is the fallback. */
export function offeringEndpoint(offering: AiProviderOffering): string | undefined {
  const protocol = offering.modelDiscovery?.endpointProtocol
  return offering.endpoints?.find((endpoint) => endpoint.protocol === protocol)?.baseUrl
    ?? offering.endpoints?.[0]?.baseUrl
}

export function endpointDisplayValue(value: string): string {
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname.replace(/\/$/u, '')}`
  } catch {
    return value
  }
}

/**
 * How a provider's own endpoint is described: by the API it serves.
 *
 * Used where the reader is inspecting what an upstream offering speaks. Xpod's
 * own endpoints are named by {@link compatibleProtocolLabel} instead, because a
 * client arrives already speaking a protocol rather than asking what Xpod uses.
 */
export function endpointProtocolLabel(protocol: string): string {
  if (protocol === 'responses') return 'Responses API'
  if (protocol === 'chatCompletions') return 'Chat API'
  if (protocol === 'anthropic') return 'Anthropic API'
  return protocol
}

/** The client protocols Xpod accepts, named the way the client's own docs name them. */
export function compatibleProtocolLabel(protocol: string): string {
  if (protocol === 'responses') return 'OpenAI Responses 兼容'
  if (protocol === 'chatCompletions') return 'OpenAI Chat 兼容'
  if (protocol === 'anthropic') return 'Anthropic Messages 兼容'
  return `${protocol} 兼容`
}
