import type { AiProviderOffering } from './ai-connections-client'

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

export function endpointProtocolLabel(protocol: string): string {
  if (protocol === 'responses') return 'Responses API'
  if (protocol === 'chatCompletions') return 'Chat API'
  if (protocol === 'anthropic') return 'Anthropic API'
  return protocol
}
