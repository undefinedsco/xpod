/**
 * Which Pod serves a Matrix server name.
 *
 * A federation request names a destination server, and the events in it belong to a room whose
 * copy lives in one of this deployment's Pods. Answering "which Pod" must not invent a record of
 * its own: a participant's server name is *derived* from their WebID (`webIdServerName`), and the
 * Pod is the one the deployment already registered for that WebID. So the answer is computed from
 * facts the deployment keeps for its own reasons — which Pods exist, and whose they are — exactly
 * like the signing identity it holds for that participant. Nothing here is a second registration,
 * and a participant who moves Pods moves by changing the registration that already exists.
 *
 * Two ambiguities are refused rather than guessed:
 *
 * - one server name claimed by several registered WebIDs (two accounts on the same host);
 * - one WebID with several registered Pods.
 *
 * Either would make "write this room's events into the participant's Pod" a coin flip, and a room
 * written into the wrong Pod is not something a reader can undo. The same policy already governs
 * which Pod a participant's signing key is minted into (`podParticipantIdentity.ts`).
 */
import { webIdServerName } from './protocol/serverName';
import { normalizePodRoot } from './MatrixPodResolver';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';

/** The Pod that serves one server name, and the participant it belongs to. */
export interface MatrixServerRoute {
  webId: string;
  /** The Pod root, normalized: what a caller joins resource paths onto. */
  podUrl: string;
}

export type MatrixServerRouteResult =
  | { kind: 'served'; route: MatrixServerRoute }
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; reason: string };

/** Every name this deployment serves, for callers that need the set rather than one answer. */
export interface MatrixServedRoutes {
  /** Server name to route, one entry per name that resolves without a coin flip. */
  served: Map<string, MatrixServerRoute>;
  /** Names that cannot be served because more than one participant claims them. */
  ambiguous: { serverName: string; reason: string }[];
}

export interface MatrixParticipantRoutesOptions {
  /**
   * The deployment's own Pod registrations. Read-only: this module never writes a
   * registration, because the registration is not its to own.
   */
  pods: Pick<PodLookupRepository, 'listAllPods'>;
}

export class MatrixParticipantRoutes {
  private readonly pods: Pick<PodLookupRepository, 'listAllPods'>;

  public constructor(options: MatrixParticipantRoutesOptions) {
    this.pods = options.pods;
  }

  /** The Pod a server name routes to, or why this deployment cannot answer. */
  public async route(serverName: string): Promise<MatrixServerRouteResult> {
    const { served, ambiguous } = await this.routes();
    const route = served.get(serverName);
    if (route) return { kind: 'served', route };
    const clash = ambiguous.find(entry => entry.serverName === serverName);
    return clash ? { kind: 'ambiguous', reason: clash.reason } : { kind: 'unknown' };
  }

  /**
   * Every route, derived from the registrations in one read.
   *
   * A participant whose WebID has no usable host is skipped: they cannot be anybody's server, so
   * inventing a name for them would produce a route nothing can ever sign for.
   */
  public async routes(): Promise<MatrixServedRoutes> {
    const claimants = new Map<string, Map<string, Set<string>>>();
    for (const pod of await this.pods.listAllPods()) {
      const podUrl = pod.baseUrl?.trim();
      if (!podUrl) continue;
      for (const webId of webIdsOf(pod)) {
        const serverName = webIdServerName(webId);
        if (!serverName) continue;
        const byWebId = claimants.get(serverName) ?? new Map<string, Set<string>>();
        const podUrls = byWebId.get(webId) ?? new Set<string>();
        podUrls.add(normalizePodRoot(podUrl));
        byWebId.set(webId, podUrls);
        claimants.set(serverName, byWebId);
      }
    }

    const served = new Map<string, MatrixServerRoute>();
    const ambiguous: { serverName: string; reason: string }[] = [];
    for (const [ serverName, byWebId ] of claimants) {
      if (byWebId.size > 1) {
        ambiguous.push({ serverName, reason: `${byWebId.size} participants are registered on ${serverName}` });
        continue;
      }
      const [ [ webId, podUrls ] ] = [ ...byWebId ];
      if (podUrls.size > 1) {
        ambiguous.push({ serverName, reason: `${webId} has ${podUrls.size} Pods registered` });
        continue;
      }
      served.set(serverName, { webId, podUrl: [ ...podUrls ][0] });
    }
    return { served, ambiguous };
  }
}

export function createParticipantRoutes(options: MatrixParticipantRoutesOptions): MatrixParticipantRoutes {
  return new MatrixParticipantRoutes(options);
}

/** The WebIDs a registration covers: the single one, plus any additional list the row carries. */
function webIdsOf(pod: PodLookupResult): string[] {
  const webIds = [ pod.webId, ...(Array.isArray(pod.webIds) ? pod.webIds : []) ]
    .filter((webId): webId is string => typeof webId === 'string' && webId.trim() !== '');
  return [ ...new Set(webIds) ];
}
