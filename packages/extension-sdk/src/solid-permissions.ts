import {
  addUrl, createSolidDataset, createThing, getLinkedResourceUrlAll, getResourceInfo,
  getSolidDataset, getThingAll, getUrlAll, saveSolidDatasetAt, setThing, universalAccess,
} from '@inrupt/solid-client';
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
  // Only this capability's direct-mode changes can be undone. A newly mounted
  // capability must never treat unrelated existing permissions as its own grant.
  const grants = new Map<string, { before: AgentModes; after: AgentModes; changed: boolean }>();
  const keyFor = (request: SolidServiceAccessRequest, url: string): string =>
    JSON.stringify([request.appletId, request.service.webId, url]);

  return {
    inspectAgentAccess: (request) => inspect(request, options.fetch, access),
    ensureAgentAccess: async (request) => {
      try {
        for (const resource of request.resources) {
          await ensureResource(resource.url, resource.mediaType, options.fetch);
          await ensureDeclaredAcr(resource.url, options.fetch);
          const current = agentModes(await access.getAgentAccess(resource.url, request.service.webId, { fetch: options.fetch }));
          const key = keyFor(request, resource.url);
          const previous = grants.get(key);
          if (previous && !sameModes(current, previous.after)) throw new Error('Agent access changed outside this capability.');
          if (hasRequestedAccess(current, resource.access)) {
            if (!previous) grants.set(key, { before: current, after: current, changed: false });
            continue;
          }
          // Add only requested modes. Existing owner control and unrequested
          // access are not removed as a side effect of granting an applet.
          const granted = await access.setAgentAccess(resource.url, request.service.webId,
            toAccessModes(resource.access), { fetch: options.fetch });
          if (!granted || !hasRequestedAccess(granted, resource.access)) {
            return status('permissionDenied', request, 'Pod did not grant the requested service access.');
          }
          grants.set(key, {
            before: previous?.before ?? current,
            after: agentModes({ ...current, ...granted }),
            changed: true,
          });
        }
        return status('granted', request);
      } catch (error) {
        return status('permissionDenied', request, errorMessage(error));
      }
    },
    revokeAgentAccess: async (request) => {
      try {
        // Validate every attribution before changing any resource. A stale or
        // cold capability cannot silently undo another operation's permissions.
        const pending = [];
        for (const resource of request.resources) {
          const grant = grants.get(keyFor(request, resource.url));
          if (!grant) throw new Error('No grant attribution exists in this capability; existing access was not revoked.');
          const current = agentModes(await access.getAgentAccess(resource.url, request.service.webId, { fetch: options.fetch }));
          if (!sameModes(current, grant.after)) throw new Error('Agent access changed outside this capability; access was not revoked.');
          pending.push({ resource, grant });
        }
        for (const { resource, grant } of pending) {
          if (!grant.changed) continue;
          const restore: Partial<AgentModes> = {};
          for (const mode of AGENT_MODES) if (grant.before[mode] !== grant.after[mode]) restore[mode] = grant.before[mode];
          const restored = await access.setAgentAccess(resource.url, request.service.webId, restore, { fetch: options.fetch });
          if (!restored || !sameModes(agentModes({ ...grant.after, ...restored }), grant.before)) {
            return status('permissionDenied', request, 'Pod did not restore this capability grant.');
          }
          grant.after = grant.before;
          grant.changed = false;
        }
        const result = await inspect(request, options.fetch, access);
        return result.status === 'granted' ? { ...result, message: 'Existing agent access was retained.' } : result;
      } catch (error) {
        return status('permissionDenied', request, errorMessage(error));
      }
    },
  };
}

const AGENT_MODES = ['read', 'append', 'write', 'controlRead', 'controlWrite'] as const;
type AgentModes = Record<typeof AGENT_MODES[number], boolean>;
function agentModes(value: Partial<AgentModes> | null | undefined): AgentModes {
  if (!value || AGENT_MODES.some(mode => typeof value[mode] !== 'boolean')) throw new Error('Unable to inspect direct agent access.');
  return Object.fromEntries(AGENT_MODES.map(mode => [mode, value[mode]])) as AgentModes;
}
function sameModes(left: AgentModes, right: AgentModes): boolean {
  return AGENT_MODES.every(mode => left[mode] === right[mode]);
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
    headers: { 'content-type': mediaType, 'if-none-match': '*' },
    body: mediaType === 'application/json' ? '{}\n' : '# Created by the Xpod applet permission broker.\n',
  });
  if (!created.ok && created.status !== 412) {
    throw new Error(`Unable to create Pod resource (${created.status}).`);
  }
}

const ACP = 'http://www.w3.org/ns/solid/acp#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Bootstrap only a server-declared, missing target ACR. Parent ACP policies
 * remain effective; no owner or inherited grants are copied or replaced. */
async function ensureDeclaredAcr(resourceUrl: string, fetch: typeof globalThis.fetch): Promise<void> {
  const info = await getResourceInfo(resourceUrl, { fetch });
  const links = getLinkedResourceUrlAll(info).acl;
  if (!links || links.length !== 1) throw new Error('Missing unambiguous access-control Link.');
  const linked = new URL(links[0]);
  const target = new URL(resourceUrl);
  if (linked.origin !== target.origin || linked.username || linked.password || linked.search || linked.hash) {
    throw new Error('Access-control Link is outside the resource authority.');
  }
  const response = await fetch(linked.href, { method: 'HEAD' });
  const declaresAcp = declaresAcpType(response.headers.get('link'));
  await response.arrayBuffer();
  if (response.ok) {
    if (declaresAcp) await assertTargetAcr(linked.href, resourceUrl, fetch);
    return;
  }
  if (response.status !== 404) throw new Error(`Unable to inspect access-control resource (${response.status}).`);
  // WAC initialization remains the responsibility of the ecosystem API.
  if (!declaresAcp) return;

  const thing = addUrl(addUrl(createThing({ url: linked.href }), RDF_TYPE, `${ACP}AccessControlResource`), `${ACP}resource`, resourceUrl);
  const dataset = setThing(createSolidDataset(), thing);
  let creationStatus: number | undefined;
  const createOnlyFetch: typeof fetch = async (input, init) => {
    const inputUrl = input instanceof Request ? input.url : String(input);
    if (inputUrl !== linked.href || init?.method !== 'PUT') throw new Error('Unexpected access-control creation request.');
    const headers = new Headers(init.headers);
    headers.set('If-None-Match', '*');
    const created = await fetch(input, { ...init, headers });
    creationStatus = created.status;
    return created;
  };
  try {
    await saveSolidDatasetAt(linked.href, dataset, { fetch: createOnlyFetch });
  } catch (error) {
    if (creationStatus !== 412) throw error;
    // A competing writer won. Read its real policies; never replace them.
    await assertTargetAcr(linked.href, resourceUrl, fetch);
  }
}

function declaresAcpType(header: string | null): boolean {
  return (header ?? '').split(/,(?=\s*<)/u).some((link) => {
    const match = /^\s*<([^<>]+)>\s*;(.*)$/u.exec(link);
    if (match?.[1] !== `${ACP}AccessControlResource`) return false;
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))(?:\s*;|\s*$)/u.exec(match[2]);
    return (rel?.[1] ?? rel?.[2] ?? '').split(/\s+/u).includes('type');
  });
}

async function assertTargetAcr(acrUrl: string, resourceUrl: string, fetch: typeof globalThis.fetch): Promise<void> {
  const dataset = await getSolidDataset(acrUrl, { fetch });
  const controls = getThingAll(dataset).filter((thing) => getUrlAll(thing, RDF_TYPE).includes(`${ACP}AccessControlResource`));
  if (controls.length !== 1) throw new Error('Invalid target access-control resource.');
  const resources = getUrlAll(controls[0], `${ACP}resource`);
  if (resources.length !== 1 || resources[0] !== resourceUrl) throw new Error('Access-control resource targets another resource.');
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

function toAccessModes(access: SolidAgentAccess): Partial<AgentModes> {
  return {
    ...(access.read ? { read: true } : {}),
    ...(access.append ? { append: true } : {}),
    ...(access.write ? { write: true } : {}),
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
