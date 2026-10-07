import { resolvePodBaseUrl } from '@undefineds.co/drizzle-solid';
import { AI_CONNECTIONS_PROVIDER_DOCUMENT_IDS } from '@undefineds.co/ai-connections/provider-catalog';
import {
  AI_CONNECTIONS_SERVICE_RESOURCE_IDS,
  resolveAiConnectionsServiceResource,
} from '@undefineds.co/ai-connections/service-access-resources';

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
    resources: AI_CONNECTIONS_SERVICE_RESOURCE_IDS.map(id => ({
      id,
      ...requiredResourceLocation(id, input.ownerWebId, input.podBaseUrl),
      access: { read: true, append: true, write: true },
    })),
  };
}

function requiredResourceLocation(id: string, ownerWebId: string, podBaseUrl?: string) {
  const location = resolveAiConnectionsServiceResource(id, podBaseUrl ?? resolvePodBaseUrl(ownerWebId));
  if (!location) throw new Error('AI Connection resource is not declared');
  return location;
}
