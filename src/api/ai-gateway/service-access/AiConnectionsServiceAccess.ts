import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import { AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS } from '@undefineds.co/ai-connections/provider-catalog';
import {
  aiProviderResource,
  credentialResource,
  quotaSnapshotResource,
} from '@undefineds.co/models';

export const AI_CONNECTIONS_APPLET_ID = 'co.undefineds.ai-connections';

/**
 * Provider documents this service may reach. The list is projected from the
 * shared provider/offering catalogue (`<provider>` plus
 * `<provider>-<offeringId>`); re-exported here because the service-access
 * descriptor is the server-side consumer of that one source, and the applet's
 * descriptor validator reads the same constant.
 */
export { AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS };

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
      ['quotaSnapshots', resourceUrl(input.ownerWebId, quotaSnapshotResource, input.podBaseUrl)],
      ...AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS.map((provider) => [
        `providerDocument:${provider}`,
        providerDocumentUrl(input.ownerWebId, provider, input.podBaseUrl),
      ] as const),
    ] as const).map(([id, url]) => ({
      id,
      url,
      mediaType: 'text/turtle',
      access: { read: true, append: true, write: true },
    })) as AiConnectionsServiceAccessResource[],
  };
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
