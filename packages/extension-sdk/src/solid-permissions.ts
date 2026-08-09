import { universalAccess } from '@inrupt/solid-client';
import type {
  SolidAgentAccess,
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  SolidServiceAccessStatus,
} from './web';

type UniversalAccess = Pick<typeof universalAccess, 'getAgentAccess' | 'setAgentAccess'>;

export interface SolidPermissionCapabilityOptions {
  fetch: typeof fetch;
  access?: UniversalAccess;
}

/**
 * Creates the host-owned permission broker used by trusted applets. The applet
 * declares exact Pod resources; the host is the only layer allowed to inspect
 * or change their WebACL/ACP grants.
 */
export function createSolidPermissionCapability(
  options: SolidPermissionCapabilityOptions,
): SolidPermissionCapability {
  const access = options.access ?? universalAccess;

  return {
    inspectAgentAccess: (request) => inspect(request, options.fetch, access),
    ensureAgentAccess: async (request) => {
      try {
        for (const resource of request.resources) {
          await ensureResource(resource.url, resource.mediaType, options.fetch);
          const granted = await access.setAgentAccess(
            resource.url,
            request.service.webId,
            toAccessModes(resource.access),
            { fetch: options.fetch },
          );
          if (!granted || !hasRequestedAccess(granted, resource.access)) {
            return status('permissionDenied', request, 'Pod did not grant the requested service access.');
          }
        }
        return status('granted', request);
      } catch (error) {
        return status('permissionDenied', request, errorMessage(error));
      }
    },
    revokeAgentAccess: async (request) => {
      try {
        for (const resource of request.resources) {
          const revoked = await access.setAgentAccess(
            resource.url,
            request.service.webId,
            { read: false, append: false, write: false, controlRead: false, controlWrite: false },
            { fetch: options.fetch },
          );
          if (!revoked) {
            return status('permissionDenied', request, 'Pod did not revoke the service access.');
          }
        }
        return status('missing', request);
      } catch (error) {
        return status('permissionDenied', request, errorMessage(error));
      }
    },
  };
}

async function inspect(
  request: SolidServiceAccessRequest,
  fetch: typeof globalThis.fetch,
  access: UniversalAccess,
): Promise<SolidServiceAccessStatus> {
  try {
    for (const resource of request.resources) {
      const granted = await access.getAgentAccess(resource.url, request.service.webId, { fetch });
      if (!granted || !hasRequestedAccess(granted, resource.access)) {
        return status('missing', request);
      }
    }
    return status('granted', request);
  } catch (error) {
    return status('permissionDenied', request, errorMessage(error));
  }
}

async function ensureResource(url: string, mediaType: string, fetch: typeof globalThis.fetch): Promise<void> {
  const existing = await fetch(url, { method: 'HEAD' });
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(`Unable to inspect Pod resource (${existing.status}).`);
  }
  await ensureParentContainers(url, fetch);
  const created = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: '# Created by the Xpod applet permission broker.\n',
  });
  if (!created.ok) {
    throw new Error(`Unable to create Pod resource (${created.status}).`);
  }
}

async function ensureParentContainers(resourceUrl: string, fetch: typeof globalThis.fetch): Promise<void> {
  const resource = new URL(resourceUrl);
  const missing: string[] = [];
  let parent = new URL('./', resource);

  while (parent.pathname !== '/') {
    const response = await fetch(parent.href, { method: 'HEAD' });
    if (response.ok) break;
    if (response.status !== 404) {
      throw new Error(`Unable to inspect Pod container (${response.status}).`);
    }
    missing.push(parent.href);
    parent = new URL('../', parent);
  }

  for (const url of missing.reverse()) {
    const created = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'text/turtle',
        link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
      },
      body: '',
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`Unable to create Pod container (${created.status}).`);
    }
  }
}

function toAccessModes(access: SolidAgentAccess) {
  return {
    read: access.read === true,
    append: access.append === true,
    write: access.write === true,
    controlRead: false,
    controlWrite: false,
  };
}

function hasRequestedAccess(
  actual: { read?: boolean; append?: boolean; write?: boolean },
  requested: SolidAgentAccess,
): boolean {
  return (!requested.read || actual.read === true)
    && (!requested.append || actual.append === true)
    && (!requested.write || actual.write === true);
}

function status(
  value: SolidServiceAccessStatus['status'],
  request: SolidServiceAccessRequest,
  message?: string,
): SolidServiceAccessStatus {
  return { status: value, resources: request.resources, ...(message ? { message } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to update Pod service access.';
}
