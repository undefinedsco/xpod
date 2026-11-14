import {
  aiProviderResource,
  credentialResource,
  quotaSnapshotResource,
} from '@undefineds.co/models'
import { AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS } from './contract/provider-catalog'

interface DeclaredResource {
  config?: { base?: string }
  buildId(value: { id: string }): string
}

export interface AiConnectionsServiceResourceLocation {
  url: string
  mediaType: 'text/turtle' | 'application/json'
}

// Capture model declarations before a database hydrates their mutable runtime paths.
// Permissions target HTTP documents; RDF subject fragments remain model identities.
function declaredDocumentPath(resource: DeclaredResource, id = '__service_access__'): string {
  const base = resource.config?.base?.replace(/^\/+|\/+$/gu, '')
  if (!base) throw new Error('AI Connection resource is missing a declared base')
  return `${base}/${resource.buildId({ id }).split('#')[0]}`.replace(/^\/+/u, '')
}

const RDF_RESOURCE_PATHS = Object.freeze({
  providerCredentials: declaredDocumentPath(credentialResource),
  providerDefinitions: declaredDocumentPath(aiProviderResource),
  quotaSnapshots: declaredDocumentPath(quotaSnapshotResource),
})

const PROVIDER_DOCUMENT_PATHS = new Map(AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS.map(id => [
  `providerDocument:${id}`,
  declaredDocumentPath(aiProviderResource, id),
]))

export type AiConnectionsServiceResourceId = keyof typeof RDF_RESOURCE_PATHS
  | `providerDocument:${string}`

export const AI_CONNECTIONS_SERVICE_RESOURCE_IDS: readonly AiConnectionsServiceResourceId[] = [
  'providerCredentials',
  'providerDefinitions',
  'quotaSnapshots',
  ...[...PROVIDER_DOCUMENT_PATHS.keys()] as `providerDocument:${string}`[],
] as const

/** Resolve only capability-declared documents inside an already verified Pod binding. */
export function resolveAiConnectionsServiceResource(
  id: string,
  podBaseUrl: string,
): AiConnectionsServiceResourceLocation | undefined {
  const mediaType = 'text/turtle'
  const path = Object.prototype.hasOwnProperty.call(RDF_RESOURCE_PATHS, id)
    ? RDF_RESOURCE_PATHS[id as keyof typeof RDF_RESOURCE_PATHS]
    : PROVIDER_DOCUMENT_PATHS.get(id)
  if (!path) return undefined
  const root = podBaseUrl.endsWith('/') ? podBaseUrl : `${podBaseUrl}/`
  return { url: new URL(path, root).href, mediaType }
}
