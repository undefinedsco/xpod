import { describe, expect, it, vi } from 'vitest';
import { createSolidPermissionCapability } from '../src/solid-permissions';
import type { SolidServiceAccessRequest } from '../src/web';
const target = 'https://pod.example/alice/settings/credentials.ttl';
const acr = 'https://pod.example/alice/acl-metadata/credentials';
const acp = 'http://www.w3.org/ns/solid/acp#';
const request: SolidServiceAccessRequest = { appletId: 'test', service: { webId: 'https://service.example/#me', label: 'service' }, resources: [{ id: 'credentials', url: target, mediaType: 'text/turtle', access: { read: true, write: true, append: true } }] };
function fixture(options: { existing?: boolean; race?: boolean; denied?: boolean; type?: string; missingLink?: boolean; foreignLink?: boolean; wrongTarget?: boolean; disappeared?: boolean; modes?: Partial<{ read: boolean; append: boolean; write: boolean; controlRead: boolean; controlWrite: boolean }> } = {}) {
  let existing = !!options.existing;
  const original = `<${acr}> a <${acp}AccessControlResource>; <${acp}resource> <${options.wrongTarget ? 'https://pod.example/bob/file' : target}>. <#other-agent> <https://example/preserve> "yes".\n`;
  let body = original;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers({ 'content-type': 'text/turtle' });
    if (url === target) {
      if (!options.missingLink) headers.set('link', `<${options.foreignLink ? 'https://foreign.example/acr' : acr}>; rel="acl"`);
      return new Response(null, { status: 200, headers });
    }
    if (url !== acr) throw new Error('Unexpected authority or guessed ACR URL');
    headers.set('link', `<${options.type ?? `${acp}AccessControlResource`}>; rel="type"`);
    if (init?.method === 'PUT') {
      expect(new Headers(init.headers).get('if-none-match')).toBe('*');
      if (options.denied) return new Response(null, { status: 403 });
      if (options.race) { existing = true; return new Response(null, { status: 412 }); }
      expect(existing).toBe(false);
      existing = true;
      body = String(init.body);
      return new Response(null, { status: 201, headers });
    }
    return new Response(init?.method === 'HEAD' ? null : body, { status: existing && !(options.disappeared && init?.method !== 'HEAD') ? 200 : 404, headers });
  });
  let modes = { read: false, append: false, write: false, controlRead: false, controlWrite: false, ...options.modes };
  const access = {
    getAgentAccess: vi.fn(async () => ({ ...modes })),
    setAgentAccess: vi.fn(async (_url: string, _agent: string, update: Partial<typeof modes>) => {
      if (!existing) return null; modes = { ...modes, ...update }; return { ...modes };
    }),
  };
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  }) as typeof globalThis.fetch;
  return { fetch: transport, calls: fetch.mock.calls, access, body: () => body, original };
}
describe('declared target ACP initialization', () => {
  it('initializes only the linked missing target ACR and leaves inheritance untouched', async () => {
    const f = fixture();
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    const result = await capability.ensureAgentAccess(request);
    expect(result.status, result.message).toBe('granted');
    expect(f.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => String(url))).toEqual([acr]);
    expect(f.body()).toContain(acp);
    expect(f.body()).toContain(target);
    expect(f.body()).not.toContain('memberAccessControl');
    expect(f.body()).not.toContain(request.service.webId);
    expect(f.access.setAgentAccess).toHaveBeenCalledWith(target, request.service.webId, { read: true, write: true, append: true }, expect.any(Object));
  });
  it('preserves an existing ACR and other-agent policies for the ecosystem mutation', async () => {
    const f = fixture({ existing: true });
    expect(await createSolidPermissionCapability({ fetch: f.fetch, access: f.access }).ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(f.body()).toBe(f.original);
    expect(f.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('uses the concurrently created ACR after a conditional-create 412 without overwriting it', async () => {
    const f = fixture({ race: true });
    expect(await createSolidPermissionCapability({ fetch: f.fetch, access: f.access }).ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(f.body()).toBe(f.original);
    expect(f.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
  it.each([{ existing: true, wrongTarget: true }, { race: true, wrongTarget: true }, { race: true, disappeared: true }, { denied: true }, { missingLink: true }, { foreignLink: true }, { type: 'https://example/NotACP' }])('never initializes or claims access on a refused or undeclared ACR: %j', async (options) => {
    const f = fixture(options);
    expect(await createSolidPermissionCapability({ fetch: f.fetch, access: f.access }).ensureAgentAccess(request)).toMatchObject({ status: 'permissionDenied' });
    expect(f.body()).toBe(f.original);
    if (!options.denied && !options.race) expect(f.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
  it('does not submit a no-op mutation when the public API already reports the required access', async () => {
    const f = fixture({ existing: true });
    f.access.getAgentAccess.mockResolvedValue({ read: true, write: true, append: true, controlRead: false, controlWrite: false });
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await capability.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(f.access.getAgentAccess).toHaveBeenCalledWith(target, request.service.webId, expect.objectContaining({ fetch: f.fetch }));
    expect(f.access.setAgentAccess).not.toHaveBeenCalled();
    expect(f.body()).toBe(f.original);
  });
  it('still applies a grant when a required access mode is missing', async () => {
    const f = fixture({ existing: true });
    f.access.getAgentAccess.mockResolvedValue({ read: true, write: false, append: false, controlRead: false, controlWrite: false });
    expect(await createSolidPermissionCapability({ fetch: f.fetch, access: f.access }).ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(f.access.setAgentAccess).toHaveBeenCalledOnce();
  });
  it('restores only this capability changes and makes repeated revocation a read-only operation', async () => {
    const f = fixture({ existing: true });
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await capability.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(await capability.revokeAgentAccess(request)).toMatchObject({ status: 'missing' });
    expect(f.access.setAgentAccess).toHaveBeenLastCalledWith(target, request.service.webId, { read: false, append: false, write: false }, expect.any(Object));
    const changes = f.access.setAgentAccess.mock.calls.length;
    expect(await capability.revokeAgentAccess(request)).toMatchObject({ status: 'missing' });
    expect(f.access.setAgentAccess.mock.calls).toHaveLength(changes);
  });
  it('preserves skipped-existing broader agent access including owner control', async () => {
    const f = fixture({ existing: true });
    f.access.getAgentAccess.mockResolvedValue({ read: true, write: true, append: true, controlRead: true, controlWrite: true });
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await capability.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(await capability.revokeAgentAccess(request)).toMatchObject({ status: 'granted', message: expect.stringContaining('retained') });
    expect(f.access.setAgentAccess).not.toHaveBeenCalled();
  });
  it('restores only newly added write and append while retaining existing read and owner control', async () => {
    const original = { read: true, append: false, write: false, controlRead: true, controlWrite: true };
    const f = fixture({ existing: true, modes: original });
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await capability.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    expect(await f.access.getAgentAccess()).toEqual({ ...original, append: true, write: true });
    expect(f.access.setAgentAccess).toHaveBeenCalledWith(target, request.service.webId, { read: true, append: true, write: true }, expect.any(Object));
    expect(await capability.revokeAgentAccess(request)).toMatchObject({ status: 'missing' });
    expect(f.access.setAgentAccess).toHaveBeenLastCalledWith(target, request.service.webId, { append: false, write: false }, expect.any(Object));
    expect(await f.access.getAgentAccess()).toEqual(original);
    expect(f.access.setAgentAccess).toHaveBeenCalledTimes(2);
  });
  it('does not claim cold capability revocation of an unattributed existing grant', async () => {
    const f = fixture({ existing: true });
    const first = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await first.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    const calls = f.access.setAgentAccess.mock.calls.length;
    const fresh = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await fresh.revokeAgentAccess(request)).toMatchObject({ status: 'permissionDenied', message: expect.stringContaining('attribution') });
    expect(f.access.setAgentAccess.mock.calls).toHaveLength(calls);
  });
  it('refuses to restore a stale snapshot after another operation changes direct modes', async () => {
    const f = fixture({ existing: true });
    const capability = createSolidPermissionCapability({ fetch: f.fetch, access: f.access });
    expect(await capability.ensureAgentAccess(request)).toMatchObject({ status: 'granted' });
    f.access.getAgentAccess.mockResolvedValue({ read: true, write: true, append: true, controlRead: true, controlWrite: true });
    const calls = f.access.setAgentAccess.mock.calls.length;
    expect(await capability.revokeAgentAccess(request)).toMatchObject({ status: 'permissionDenied', message: expect.stringContaining('changed') });
    expect(f.access.setAgentAccess.mock.calls).toHaveLength(calls);
  });
  it('creates declared JSON as valid empty JSON and keeps existing contents untouched', async () => {
    const puts: RequestInit[] = [];
    let present = false;
    const responseAt = (input: RequestInfo | URL, status: number, headers?: HeadersInit) => {
      const response = new Response(null, { status, headers });
      Object.defineProperty(response, 'url', { value: String(input) });
      return response;
    };
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== target) return responseAt(input, 200);
      if (init?.method === 'PUT') { puts.push(init); present = true; return responseAt(input, 201); }
      return responseAt(input, present ? 200 : 404, { link: `<${acr}>; rel="acl"` });
    }) as typeof globalThis.fetch;
    const access = { getAgentAccess: vi.fn(async () => ({ read: false, append: false, write: false, controlRead: false, controlWrite: false })), setAgentAccess: vi.fn(async () => ({ read: true, write: true, append: true })) };
    const jsonRequest = { ...request, resources: [{ ...request.resources[0], mediaType: 'application/json' as const }] };
    const capability = createSolidPermissionCapability({ fetch, access });
    expect(await capability.ensureAgentAccess(jsonRequest)).toMatchObject({ status: 'granted' });
    expect(new Headers(puts[0].headers).get('if-none-match')).toBe('*');
    expect(JSON.parse(String(puts[0].body))).toEqual({});
    expect(new Headers(puts[0].headers).get('content-type')).toBe('application/json');
    await capability.ensureAgentAccess(jsonRequest);
    expect(puts).toHaveLength(1);
  });
});
