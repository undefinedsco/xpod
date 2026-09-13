import type {
  SolidAgentAccess,
  SolidServiceAccessRequest,
  SolidServiceAccessResource,
} from '@undefineds.co/extension-sdk/web'

export const AI_CONNECTIONS_APPLET_ID = 'co.undefineds.ai-connections'

const KNOWN_RESOURCE_PATHS = {
  providerCredentials: 'settings/credentials.ttl',
  providerDefinitions: 'settings/providers/__service_access__.ttl',
  gatewayAccessKeys: '.data/ai/gateway/access-keys.ttl',
  quotaSnapshots: '.data/ai/gateway/quota.ttl',
} as const
const PROVIDER_DOCUMENT_IDS = [
  'openai',
  'openai-official-subscription',
  'openai-api-platform',
  'anthropic',
  'anthropic-official-subscription',
  'anthropic-api-platform',
  'kimi',
  'kimi-subscription-key',
  'kimi-api-platform',
  'bailian',
  'bailian-pay-as-you-go',
  'bailian-token-plan',
  'bailian-token-plan-team',
  'bailian-coding-plan',
  'deepseek',
  'deepseek-api-platform',
  'zhipu',
  'zhipu-api-platform',
  'zhipu-coding-plan',
  'ollama',
  'ollama-local',
  'custom',
  'custom-openai-compatible',
  'custom-anthropic-compatible',
] as const

const PROVIDER_DOCUMENT_ID_SET = new Set<string>(PROVIDER_DOCUMENT_IDS)

export function parseAiConnectionsServiceAccess(
  value: unknown,
  currentPodUrl: string,
): SolidServiceAccessRequest {
  if (!isRecord(value)) throw new Error('invalid_descriptor')
  if (value.appletId !== AI_CONNECTIONS_APPLET_ID) throw new Error('invalid_applet_id')

  const service = value.service
  if (!isRecord(service)
    || typeof service.webId !== 'string'
    || typeof service.label !== 'string'
    || !isAbsoluteHttpUrl(service.webId)) {
    throw new Error('invalid_service')
  }

  if (!Array.isArray(value.resources) || value.resources.length === 0) {
    throw new Error('invalid_empty_resources')
  }

  const podRoot = normalizeContainerUrl(currentPodUrl)
  const ids = new Set<string>()
  const resources = value.resources.map((resource) => parseResource(resource, podRoot, ids))

  return {
    appletId: AI_CONNECTIONS_APPLET_ID,
    service: {
      webId: service.webId,
      label: service.label,
    },
    resources,
  }
}

function parseResource(
  value: unknown,
  podRoot: URL,
  ids: Set<string>,
): SolidServiceAccessResource {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.url !== 'string'
    || value.mediaType !== 'text/turtle'
    || !isRecord(value.access)) {
    throw new Error('invalid_resource')
  }
  // providerDefinitions 支持两种形态:成员容器(origin,settings/providers/ 带 members)
  // 或文档形式(本地,settings/providers/__service_access__.ttl,无 members)。
  const isMembersContainer = value.id === 'providerDefinitions' && value.members === true
  const expectedResourceUrl = expectedResourceHref(value.id, podRoot, isMembersContainer)
  if (!expectedResourceUrl || ids.has(value.id)) {
    throw new Error('invalid_resource')
  }
  // members 只允许出现在 providerDefinitions(成员容器形态);providerDefinitions 的
  // 两种形态(容器/文档)由下面的 URL 精确匹配区分。
  if (value.members === true && value.id !== 'providerDefinitions') {
    throw new Error('invalid_resource')
  }
  assertSafeResourceUrlString(value.url)

  let url: URL
  try {
    url = new URL(value.url)
  } catch {
    throw new Error('invalid_resource')
  }
  if (!isInsideContainer(url, podRoot)) {
    throw new Error('invalid_resource')
  }
  if (url.href !== expectedResourceUrl) {
    throw new Error('invalid_resource')
  }

  ids.add(value.id)
  return {
    id: value.id,
    url: url.href,
    mediaType: 'text/turtle',
    ...(value.members === true ? { members: true as const } : {}),
    access: parseAccess(value.access),
  }
}

function expectedResourceHref(id: string, podRoot: URL, isMembersContainer = false): string | undefined {
  if (id === 'providerDefinitions') {
    return new URL(isMembersContainer ? 'settings/providers/' : KNOWN_RESOURCE_PATHS.providerDefinitions, podRoot).href
  }
  const knownPath = KNOWN_RESOURCE_PATHS[id as keyof typeof KNOWN_RESOURCE_PATHS]
  if (knownPath) {
    return new URL(knownPath, podRoot).href
  }

  const providerDocumentId = id.startsWith('providerDocument:')
    ? id.slice('providerDocument:'.length)
    : undefined
  if (providerDocumentId && PROVIDER_DOCUMENT_ID_SET.has(providerDocumentId)) {
    return new URL(`settings/providers/${providerDocumentId}.ttl`, podRoot).href
  }
  return undefined
}

function assertSafeResourceUrlString(value: string): void {
  if (/%(?![0-9a-fA-F]{2})/.test(value)
    || /%(?:2f|5c)/i.test(value)
    || value.includes('\\')) {
    throw new Error('invalid_resource')
  }

  const rawPath = extractRawPath(value)
  if (hasDotSegment(rawPath)) {
    throw new Error('invalid_resource')
  }

  try {
    const decodedPath = decodeURIComponent(rawPath)
    if (decodedPath.includes('\\') || hasDotSegment(decodedPath)) {
      throw new Error('invalid_resource')
    }
  } catch {
    throw new Error('invalid_resource')
  }
}

function extractRawPath(value: string): string {
  const withoutHash = value.split('#', 1)[0] ?? value
  const withoutQuery = withoutHash.split('?', 1)[0] ?? withoutHash
  return withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]*/i, '')
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..')
}

function parseAccess(value: Record<string, unknown>): SolidAgentAccess {
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'read' && key !== 'append' && key !== 'write')
    || value.read !== true
    || value.append !== true
    || value.write !== true) {
    throw new Error('invalid_resource')
  }
  return {
    read: true,
    append: true,
    write: true,
  }
}

function normalizeContainerUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid_current_pod')
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`
  }
  return url
}

function isInsideContainer(url: URL, root: URL): boolean {
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.origin === root.origin
    && url.pathname.startsWith(root.pathname)
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
