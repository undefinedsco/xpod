import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import {
  aiProviderResource,
  credentialResource,
  gatewayAccessKeyResource,
  quotaSnapshotResource,
} from '@undefineds.co/models';

export const AI_CONNECTIONS_APPLET_ID = 'co.undefineds.ai-connections';
export const AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS = [
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
] as const;

export interface AiConnectionsServiceAccessDescriptor {
  appletId: typeof AI_CONNECTIONS_APPLET_ID;
  service: {
    webId: string;
    label: 'Xpod AI Connection';
  };
  resources: AiConnectionsServiceAccessResource[];
}

export interface AiConnectionsServiceAccessResource {
  id:
    | 'providerCredentials'
    | 'providerDefinitions'
    | 'gatewayAccessKeys'
    | 'gatewayAccessKeySecrets'
    | 'quotaSnapshots'
    | `providerDocument:${string}`;
  url: string;
  mediaType: 'text/turtle' | 'application/json';
  access: {
    read: true;
    append: true;
    write: true;
    controlRead?: never;
    controlWrite?: never;
  };
}

interface PodResourceLocator {
  config?: {
    base?: string;
  };
  buildId(value: { id: string }): string;
}

const declaredResourceBases = new WeakMap<object, string>([
  [credentialResource, declaredResourceBase(credentialResource)],
  [aiProviderResource, declaredResourceBase(aiProviderResource)],
  [gatewayAccessKeyResource, declaredResourceBase(gatewayAccessKeyResource)],
  [quotaSnapshotResource, declaredResourceBase(quotaSnapshotResource)],
]);

export function createAiConnectionsServiceAccess(input: {
  ownerWebId: string;
  serviceWebId: string;
  podBaseUrl?: string;
}): AiConnectionsServiceAccessDescriptor {
  return {
    appletId: AI_CONNECTIONS_APPLET_ID,
    service: {
      webId: input.serviceWebId,
      label: 'Xpod AI Connection',
    },
    resources: ([
      ['providerCredentials', resourceUrl(input.ownerWebId, credentialResource, input.podBaseUrl)],
      ['providerDefinitions', resourceUrl(input.ownerWebId, aiProviderResource, input.podBaseUrl)],
      ['gatewayAccessKeys', resolveGatewayAccessKeyResourceUrl(input.ownerWebId, input.podBaseUrl)],
      ['gatewayAccessKeySecrets', resolveGatewayAccessKeySecretResourceUrl(input.ownerWebId, input.podBaseUrl), 'application/json'],
      ['quotaSnapshots', resourceUrl(input.ownerWebId, quotaSnapshotResource, input.podBaseUrl)],
      ...AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS.map((provider) => [
        `providerDocument:${provider}`,
        providerDocumentUrl(input.ownerWebId, provider, input.podBaseUrl),
      ] as const),
    ] as const).map(([id, url, mediaType]) => ({
      id,
      url,
      mediaType: mediaType ?? 'text/turtle',
      access: { read: true, append: true, write: true },
    })) as AiConnectionsServiceAccessResource[],
  };
}

export function resolveGatewayAccessKeyResourceUrl(ownerWebId: string, podBaseUrl?: string): string {
  return resourceUrl(ownerWebId, gatewayAccessKeyResource, podBaseUrl);
}

export function resolveGatewayAccessKeySecretResourceUrl(ownerWebId: string, podBaseUrl?: string): string {
  const podRoot = `${(podBaseUrl ?? resolvePodBaseUrl(ownerWebId)).replace(/\/$/u, '')}/`;
  return new URL('.data/ai/gateway/access-key-secrets.json', podRoot).href;
}

export function resolveGatewayAccessKeySparqlEndpoint(ownerWebId: string, podBaseUrl?: string): string {
  return `${resolveGatewayAccessKeyResourceUrl(ownerWebId, podBaseUrl).replace(/\/$/u, '')}/-/sparql`;
}

export function isGatewayAccessKeySparqlEndpoint(
  ownerWebId: string,
  resourceUrlValue: URL | string,
): boolean {
  try {
    const resource = typeof resourceUrlValue === 'string' ? new URL(resourceUrlValue) : resourceUrlValue;
    const endpoint = new URL(resolveGatewayAccessKeySparqlEndpoint(ownerWebId));
    return resource.origin === endpoint.origin && resource.pathname === endpoint.pathname;
  } catch {
    return false;
  }
}

function resourceUrl(ownerWebId: string, resource: PodResourceLocator, podBaseUrl?: string): string {
  const podRoot = `${(podBaseUrl ?? resolvePodBaseUrl(ownerWebId)).replace(/\/$/u, '')}/`;
  const resourcePath = declaredResourceBases.get(resource as object);
  if (!resourcePath) {
    throw new Error('AI Connection resource is missing an immutable declared base');
  }
  const documentPath = resource.buildId({ id: '__service_access__' }).split('#')[0];
  return new URL(`${resourcePath}/${documentPath}`.replace(/^\/+/u, ''), podRoot).href;
}

function providerDocumentUrl(ownerWebId: string, provider: string, podBaseUrl?: string): string {
  const podRoot = `${(podBaseUrl ?? resolvePodBaseUrl(ownerWebId)).replace(/\/$/u, '')}/`;
  return new URL(`settings/providers/${provider}.ttl`, podRoot).href;
}

function declaredResourceBase(resource: PodResourceLocator): string {
  const base = resource.config?.base?.replace(/^\/+|\/+$/gu, '');
  if (!base) {
    throw new Error('AI Connection resource is missing a declared base');
  }
  return base;
}
