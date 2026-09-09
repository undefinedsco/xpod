import type {
  SolidServiceAccessRequest,
  SolidServiceAccessStatus,
} from '@undefineds.co/extension-sdk/web';

const ACP_NS = 'http://www.w3.org/ns/solid/acp#';
const ACL_NS = 'http://www.w3.org/ns/auth/acl#';

export interface ServiceAccessAcrOptions {
  ownerWebId: string;
  serviceWebId: string;
}

/**
 * Managed ACR for xpod-owned containers (e.g. settings/). Grants the owner
 * full access and the applet backend service Read+Write, on the container
 * itself and inherited by all members. Replaces any inherited member policies,
 * so the owner's grant must always be included.
 */
export function buildServiceAccessAcrTurtle(
  containerUrl: string,
  { ownerWebId, serviceWebId }: ServiceAccessAcrOptions,
  includeService = true,
): string {
  const serviceBlocks = includeService
    ? `
<#serviceAccess>
    a acp:AccessControl;
    acp:apply [
        a acp:Policy;
        acp:allow acl:Read, acl:Write;
        acp:anyOf [
            a acp:Matcher;
            acp:agent <${serviceWebId}>
        ]
    ].
`
    : '';
  const accessRefs = includeService ? '<#ownerAccess>, <#serviceAccess>' : '<#ownerAccess>';
  return `@prefix acl: <${ACL_NS}>.
@prefix acp: <${ACP_NS}>.

<#managed>
    a acp:AccessControlResource;
    acp:resource <${containerUrl}>;
    acp:accessControl ${accessRefs};
    acp:memberAccessControl ${accessRefs}.

<#ownerAccess>
    a acp:AccessControl;
    acp:apply [
        a acp:Policy;
        acp:allow acl:Read, acl:Write, acl:Control;
        acp:anyOf [
            a acp:Matcher;
            acp:agent <${ownerWebId}>
        ]
    ].
${serviceBlocks}`;
}

export function containerUrlForResource(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  if (url.pathname.endsWith('/')) {
    return url.toString();
  }
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  return url.toString();
}

export function acrUrlForContainer(containerUrl: string): string {
  return new URL('.acr', containerUrl).toString();
}

export function uniqueContainersForRequest(request: SolidServiceAccessRequest): string[] {
  return [...new Set(request.resources.map((resource) => containerUrlForResource(resource.url)))];
}

async function putAcr(
  authenticatedFetch: typeof fetch,
  acrUrl: string,
  turtle: string,
): Promise<void> {
  const response = await authenticatedFetch(acrUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle' },
    body: turtle,
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(`service_acr_write_failed:${response.status}`);
  }
}

function grantedWhenAllContainersGranted(
  request: SolidServiceAccessRequest,
  granted: boolean,
  message?: string,
): SolidServiceAccessStatus {
  return {
    status: granted ? 'granted' : 'missing',
    resources: request.resources,
    ...(message ? { message } : {}),
  };
}

export function createServiceAccessPermissionCapability(options: {
  authenticatedFetch: typeof fetch;
  ownerWebId?: string;
}) {
  const requireOwnerWebId = (): string => {
    if (!options.ownerWebId) {
      throw new Error('service_acr_owner_missing');
    }
    return options.ownerWebId;
  };

  return {
    async ensureAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus> {
      const ownerWebId = requireOwnerWebId();
      for (const containerUrl of uniqueContainersForRequest(request)) {
        await putAcr(
          options.authenticatedFetch,
          acrUrlForContainer(containerUrl),
          buildServiceAccessAcrTurtle(containerUrl, { ownerWebId, serviceWebId: request.service.webId }),
        );
      }
      return { status: 'granted', resources: request.resources };
    },
    async inspectAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus> {
      try {
        for (const containerUrl of uniqueContainersForRequest(request)) {
          const response = await options.authenticatedFetch(acrUrlForContainer(containerUrl), {
            headers: { accept: 'text/turtle' },
          });
          if (!response.ok) {
            await response.arrayBuffer().catch(() => undefined);
            return grantedWhenAllContainersGranted(request, false);
          }
          const turtle = await response.text();
          if (!turtle.includes(`<${request.service.webId}>`) || !turtle.includes('acp:AccessControlResource')) {
            return grantedWhenAllContainersGranted(request, false);
          }
        }
        return grantedWhenAllContainersGranted(request, true);
      } catch {
        return grantedWhenAllContainersGranted(request, false);
      }
    },
    async revokeAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus> {
      const ownerWebId = requireOwnerWebId();
      for (const containerUrl of uniqueContainersForRequest(request)) {
        await putAcr(
          options.authenticatedFetch,
          acrUrlForContainer(containerUrl),
          buildServiceAccessAcrTurtle(containerUrl, { ownerWebId, serviceWebId: request.service.webId }, false),
        );
      }
      return { status: 'missing', resources: request.resources };
    },
  };
}
