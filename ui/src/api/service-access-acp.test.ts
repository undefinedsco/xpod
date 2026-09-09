import { describe, expect, test, vi } from 'vitest';
import type { SolidServiceAccessRequest } from '@undefineds.co/extension-sdk/web';
import {
  acrUrlForContainer,
  buildServiceAccessAcrTurtle,
  containerUrlForResource,
  createServiceAccessPermissionCapability,
  uniqueContainersForRequest,
} from './service-access-acp';

const OWNER = 'http://localhost:3000/alice/profile/card#me';
const SERVICE = 'http://localhost:3000/test/profile/card#me';

const request: SolidServiceAccessRequest = {
  appletId: 'co.undefineds.ai-connections',
  service: { webId: SERVICE, label: 'Xpod AI Connection' },
  resources: [
    {
      id: 'providerCredentials',
      url: 'http://localhost:3000/alice/settings/credentials.ttl',
      mediaType: 'text/turtle',
      access: { read: true, append: true },
    },
    {
      id: 'gatewayKeys',
      url: 'http://localhost:3000/alice/settings/gateway/keys.ttl',
      mediaType: 'text/turtle',
      access: { read: true, write: true },
    },
  ],
};

describe('service-access-acp', () => {
  test('derives container URLs from resources', () => {
    expect(containerUrlForResource('http://localhost:3000/alice/settings/credentials.ttl'))
      .toBe('http://localhost:3000/alice/settings/');
    expect(containerUrlForResource('http://localhost:3000/alice/settings/'))
      .toBe('http://localhost:3000/alice/settings/');
    expect(acrUrlForContainer('http://localhost:3000/alice/settings/'))
      .toBe('http://localhost:3000/alice/settings/.acr');
    expect(uniqueContainersForRequest(request)).toEqual([
      'http://localhost:3000/alice/settings/',
      'http://localhost:3000/alice/settings/gateway/',
    ]);
  });

  test('ACR turtle grants owner full access and service read/write', () => {
    const turtle = buildServiceAccessAcrTurtle('http://localhost:3000/alice/settings/', {
      ownerWebId: OWNER,
      serviceWebId: SERVICE,
    });
    expect(turtle).toContain('acp:resource <http://localhost:3000/alice/settings/>');
    expect(turtle).toContain('acl:Read, acl:Write, acl:Control');
    expect(turtle).toContain('acl:Read, acl:Write');
    expect(turtle).toContain(`acp:agent <${OWNER}>`);
    expect(turtle).toContain(`acp:agent <${SERVICE}>`);
    expect(turtle).toContain('acp:memberAccessControl <#ownerAccess>, <#serviceAccess>');
  });

  test('owner-only turtle omits the service grant', () => {
    const turtle = buildServiceAccessAcrTurtle('http://localhost:3000/alice/settings/', {
      ownerWebId: OWNER,
      serviceWebId: SERVICE,
    }, false);
    expect(turtle).not.toContain(SERVICE);
    expect(turtle).toContain('acp:memberAccessControl <#ownerAccess>');
  });

  test('ensureAgentAccess PUTs a managed ACR for every container', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('', { status: 201 });
    });
    const capability = createServiceAccessPermissionCapability({
      authenticatedFetch: fetchImpl as unknown as typeof fetch,
      ownerWebId: OWNER,
    });
    const status = await capability.ensureAgentAccess(request);
    expect(status.status).toBe('granted');
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/alice/settings/.acr',
      'http://localhost:3000/alice/settings/gateway/.acr',
    ]);
    expect(calls[0]?.body).toContain(SERVICE);
    expect(calls[1]?.body).toContain('acp:resource <http://localhost:3000/alice/settings/gateway/>');
  });

  test('inspectAgentAccess reports missing when the ACR lacks the service agent', async () => {
    const fetchImpl = vi.fn(async () => new Response('@prefix acp: <x> . <#a> a acp:AccessControlResource .', { status: 200 }));
    const capability = createServiceAccessPermissionCapability({
      authenticatedFetch: fetchImpl as unknown as typeof fetch,
      ownerWebId: OWNER,
    });
    const status = await capability.inspectAgentAccess(request);
    expect(status.status).toBe('missing');
  });

  test('inspectAgentAccess reports granted when every ACR contains the service agent', async () => {
    const acr = `<#m> a acp:AccessControlResource . <#s> acp:agent <${SERVICE}> .`;
    const fetchImpl = vi.fn(async () => new Response(acr, { status: 200 }));
    const capability = createServiceAccessPermissionCapability({
      authenticatedFetch: fetchImpl as unknown as typeof fetch,
      ownerWebId: OWNER,
    });
    const status = await capability.inspectAgentAccess(request);
    expect(status.status).toBe('granted');
  });

  test('revokeAgentAccess PUTs the owner-only ACR', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('', { status: 201 });
    });
    const capability = createServiceAccessPermissionCapability({
      authenticatedFetch: fetchImpl as unknown as typeof fetch,
      ownerWebId: OWNER,
    });
    const status = await capability.revokeAgentAccess(request);
    expect(status.status).toBe('missing');
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !body.includes(SERVICE))).toBe(true);
  });

  test('ensureAgentAccess surfaces write failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    const capability = createServiceAccessPermissionCapability({
      authenticatedFetch: fetchImpl as unknown as typeof fetch,
      ownerWebId: OWNER,
    });
    await expect(capability.ensureAgentAccess(request)).rejects.toThrow('service_acr_write_failed:403');
  });
});
