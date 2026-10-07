import { describe, expect, it, vi } from 'vitest';
import { PodRdfAccessScopeResolver } from '../../src/api/runs/PodRdfAccessScopeResolver';
import { createApiRunContextRetriever } from '../../src/api/container/rdf';
import type { RunContextRetrievalInput } from '../../src/api/runs/RunExecutionBackend';
import type { StoreContext } from '../../src/api/chatkit/store';
import type { RdfEngineLike, RdfQuery, RdfTextSourceMetadata } from '../../src/storage/rdf';

const owner = 'https://identity.test/alice#me';
const pod = 'https://pod.test/alice/';
const workspace = `${pod}work/`;
const input: RunContextRetrievalInput<StoreContext> = { runId: 'run', threadId: 'thread', prompt: 'find report', conversation: [],
  config: { workspace, runner: { protocol: 'pi', type: 'pi' } }, context: { userId: owner, auth: { type: 'solid', webId: owner } } };
const source = (value: string): RdfTextSourceMetadata => ({ source: value, workspace, updatedAt: '2026-10-02T00:00:00Z' });

function setup(entries: RdfTextSourceMetadata[], statuses: Record<string, number> = {}) {
  const fetch = vi.fn(async (url: string) => new Response(null, { status: statuses[url] ?? 200 }));
  const getPodFetch = vi.fn(async () => fetch as unknown as typeof globalThis.fetch);
  const listTextSources = vi.fn(async () => entries);
  const options = { rdfEngine: { listTextSources }, podAccess: { getPodFetch }, podBaseUrlResolver: async () => pod };
  return { fetch, getPodFetch, listTextSources, options, resolver: new PodRdfAccessScopeResolver(options) };
}

describe('Run context authorization via the Pod interface', () => {
  it('includes only indexed, workspace-bound sources whose authenticated HEAD passes', async () => {
    const good = `${workspace}report.txt`; const denied = `${workspace}private.txt`; const redirect = `${workspace}redirect.txt`;
    const app = setup([source(good), source(denied), source(redirect), source(good),
      source(`${pod}work-other/foreign.txt`), source('https://outside.test/private.txt'), source('file:///secret'),
      source(`${workspace}report.txt#fragment`), { ...source(`${workspace}misindexed.txt`), workspace: 'https://outside.test/' },
    ], { [denied]: 403, [redirect]: 302 });
    const scope = await app.resolver.resolve(input);
    expect(scope).toMatchObject({ basePath: workspace, principal: owner, mode: 'read', resolved: true,
      allowedGraphUrls: [], allowedSourceUrls: [good] });
    expect(scope?.version).toMatch(/^pod-read:[a-f0-9]{64}$/);
    expect(app.fetch.mock.calls.map(([url]) => url)).toEqual([workspace, good, denied, redirect]);
    expect(app.getPodFetch).toHaveBeenCalledWith(owner, { auth: input.context.auth, podBaseUrl: pod });
    expect(app.fetch).toHaveBeenCalledWith(good, { method: 'HEAD', redirect: 'manual' });
  });

  it('rechecks permissions each time and changes the cache version after revocation', async () => {
    const good = `${workspace}report.txt`; const app = setup([source(good)]);
    const allowed = await app.resolver.resolve(input);
    app.fetch.mockImplementation(async url => new Response(null, { status: url === good ? 403 : 200 }));
    const revoked = await app.resolver.resolve(input);
    expect(revoked?.allowedSourceUrls).toEqual([]);
    expect(revoked?.version).not.toBe(allowed?.version);
    expect(app.listTextSources).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 500])('never grants a source after HTTP %s', async status => {
    const url = `${workspace}file.txt`;
    expect((await setup([source(url)], { [url]: status }).resolver.resolve(input))?.allowedSourceUrls).toEqual([]);
  });

  it('does not follow redirected responses or trust a different final response URL', async () => {
    const url = `${workspace}file.txt`; const app = setup([source(url)]);
    const redirected = new Response(null);
    Object.defineProperty(redirected, 'url', { value: 'https://outside.test/file.txt' });
    app.fetch.mockImplementation(async resource => resource === url ? redirected : new Response(null));
    expect((await app.resolver.resolve(input))?.allowedSourceUrls).toEqual([]);
  });

  it('requires an authenticated principal, owner Pod boundary and readable workspace', async () => {
    const app = setup([]);
    await expect(app.resolver.resolve({ ...input, context: { userId: owner } })).rejects.toThrow('authenticated');
    await expect(app.resolver.resolve({ ...input, config: { ...input.config, workspace: 'https://outside.test/' } })).rejects.toThrow('authenticated Pod');
    expect(app.fetch).not.toHaveBeenCalled();
    app.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(app.resolver.resolve(input)).rejects.toThrow('Read access');
  });

  it('denies source transport failures without converting them to broad permission', async () => {
    const url = `${workspace}file.txt`; const app = setup([source(url)]);
    app.fetch.mockImplementation(async resource => { if (resource === url) throw new Error('offline'); return new Response(null); });
    expect((await app.resolver.resolve(input))?.allowedSourceUrls).toEqual([]);
  });

  it('passes an empty finite scope through the shared retriever rather than granting the whole Pod', async () => {
    const app = setup([]);
    const query = vi.fn(async (...args: [RdfQuery]) => { void args; return { bindings: [], metrics: { plan: [] } }; });
    const retriever = createApiRunContextRetriever({ ...app.options.rdfEngine, query } as unknown as RdfEngineLike,
      { podAccess: app.options.podAccess, podBaseUrlResolver: app.options.podBaseUrlResolver });
    await retriever!.retrieve({ ...input, context: { ...input.context, rdfAccessScope: {
      basePath: 'https://outside.test/', principal: 'forged', mode: 'read', version: 'stale-broad-scope',
    } } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].textSearch?.[0].scope).toMatchObject({ allowedSources: [], sourcePrefix: workspace });
    expect(query.mock.calls[0][0].cache?.scope).toMatchObject({ principal: owner, allowedGraphUrls: [], allowedSourceUrls: [] });
  });
});
