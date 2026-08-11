import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import {
  aiProviderResource,
  credentialResource,
  gatewayAccessKeyResource,
  quotaSnapshotResource,
} from '@undefineds.co/models';

export const AI_CONNECTIONS_APPLET_ID = 'co.undefineds.ai-connections';

export interface AiConnectionsServiceAccessDescriptor {
  appletId: typeof AI_CONNECTIONS_APPLET_ID;
  service: {
    webId: string;
    label: 'Xpod AI Connection';
  };
  resources: AiConnectionsServiceAccessResource[];
}

export interface AiConnectionsServiceAccessResource {
  id: 'providerCredentials' | 'providerDefinitions' | 'gatewayAccessKeys' | 'quotaSnapshots' | `providerDocument:${string}`;
  url: string;
  mediaType: 'text/turtle';
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
}): AiConnectionsServiceAccessDescriptor {
  return {
    appletId: AI_CONNECTIONS_APPLET_ID,
    service: {
      webId: input.serviceWebId,
      label: 'Xpod AI Connection',
    },
    resources: [
      ['providerCredentials', resourceUrl(input.ownerWebId, credentialResource)],
      ['providerDefinitions', resourceUrl(input.ownerWebId, aiProviderResource)],
      ['gatewayAccessKeys', resourceUrl(input.ownerWebId, gatewayAccessKeyResource)],
      ['quotaSnapshots', resourceUrl(input.ownerWebId, quotaSnapshotResource)],
    ].map(([id, url]) => ({
      id,
      url,
      mediaType: 'text/turtle',
      access: { read: true, append: true, write: true },
    })) as AiConnectionsServiceAccessResource[],
  };
}

function resourceUrl(ownerWebId: string, resource: PodResourceLocator): string {
  const podRoot = `${resolvePodBaseUrl(ownerWebId).replace(/\/$/u, '')}/`;
  const resourcePath = declaredResourceBases.get(resource as object);
  if (!resourcePath) {
    throw new Error('AI Connection resource is missing an immutable declared base');
  }
  const documentPath = resource.buildId({ id: '__service_access__' }).split('#')[0];
  return new URL(`${resourcePath}/${documentPath}`.replace(/^\/+/u, ''), podRoot).href;
}

function declaredResourceBase(resource: PodResourceLocator): string {
  const base = resource.config?.base?.replace(/^\/+|\/+$/gu, '');
  if (!base) {
    throw new Error('AI Connection resource is missing a declared base');
  }
  return base;
}
