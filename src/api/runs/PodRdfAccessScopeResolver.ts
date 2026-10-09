import { createHash } from 'node:crypto';
import type { RdfAccessScope } from '../../storage/rdf/RdfAccessScope';
import type { RdfEngineLike } from '../../storage/rdf/types';
import type { StoreContext } from '../chatkit/store';
import type { AuthContext } from '../auth/AuthContext';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import { resolveOwnerPodBaseUrl, type PodBaseUrlResolver } from '../ai-gateway/pod/PodBaseUrlResolver';
import type { RunContextRetrievalInput } from './RunExecutionBackend';

/** CSS remains the authorization authority; the API only records successful Read probes. */
export class PodRdfAccessScopeResolver {
  public constructor(private readonly options: {
    rdfEngine: Pick<RdfEngineLike, 'listTextSources'>;
    podAccess: PodAccessFetchProvider;
    podBaseUrlResolver?: PodBaseUrlResolver;
  }) {}

  public async resolve(input: RunContextRetrievalInput<StoreContext>): Promise<RdfAccessScope | undefined> {
    const workspace = new URL(input.config.workspace);
    if (workspace.protocol === 'file:') return undefined;
    const auth = input.context.auth as AuthContext | undefined;
    if (auth?.type !== 'solid') throw new Error('RDF Run context requires an authenticated Pod principal');
    const pod = new URL(await resolveOwnerPodBaseUrl(auth.webId, this.options.podBaseUrlResolver));
    if (!isPodResource(workspace, pod) || workspace.hash || workspace.search) {
      throw new Error('RDF Run workspace must belong to the authenticated Pod');
    }
    const fetch = await this.options.podAccess.getPodFetch(auth.webId, { auth, podBaseUrl: pod.href });
    if (!fetch) throw new Error('RDF Run context Pod credential is unavailable');
    const workspaceRead = await readPermission(fetch, workspace.href);
    if (!workspaceRead.allowed) throw new Error('RDF Run workspace Read access is unavailable');
    if (!this.options.rdfEngine.listTextSources) throw new Error('RDF Run source enumeration is unavailable');

    const allowedSourceUrls: string[] = [];
    const observations: unknown[] = [[workspace.href, workspaceRead]];
    const seen = new Set<string>();
    const pageSize = 100;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.options.rdfEngine.listTextSources({ workspace: workspace.href, sourcePrefix: workspace.href, limit: pageSize, offset });
      for (const entry of page) {
        let resource: URL;
        try { resource = new URL(entry.source); } catch { continue; }
        if (entry.workspace !== workspace.href || !isPodResource(resource, pod) || resource.hash || resource.search
          || !isWithinWorkspace(resource.href, workspace.href) || seen.has(resource.href)) continue;
        seen.add(resource.href);
        const read = await readPermission(fetch, resource.href);
        observations.push([resource.href, read]);
        if (read.allowed) allowedSourceUrls.push(resource.href);
      }
      if (page.length < pageSize) break;
    }
    return {
      basePath: workspace.href, mode: 'read', resolved: true, principal: auth.webId,
      // Text sources do not prove named-graph ownership. The default Run query
      // reads text/vector projections only; a future fact query needs a graph grant.
      allowedGraphUrls: [], allowedSourceUrls: allowedSourceUrls.sort(),
      version: `pod-read:${createHash('sha256').update(JSON.stringify(observations)).digest('hex')}`,
    };
  }
}

function isPodResource(resource: URL, pod: URL): boolean {
  return ['http:', 'https:'].includes(resource.protocol) && !resource.username && !resource.password
    && resource.origin === pod.origin && resource.href.startsWith(pod.href);
}

function isWithinWorkspace(resource: string, workspace: string): boolean {
  return resource === workspace || resource.startsWith(workspace.endsWith('/') ? workspace : `${workspace}/`);
}

async function readPermission(fetch: typeof globalThis.fetch, resource: string): Promise<{ allowed: boolean; status: number; etag?: string }> {
  try {
    const response = await fetch(resource, { method: 'HEAD', redirect: 'manual' });
    return { allowed: response.ok && !response.redirected && (!response.url || response.url === resource),
      status: response.status, etag: response.headers.get('etag') ?? undefined };
  } catch { return { allowed: false, status: 0 }; }
}
