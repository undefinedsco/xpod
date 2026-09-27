import { describe, expect, it } from 'vitest';
import { createParticipantRoutes, MatrixParticipantRoutes } from '../../../src/api/matrix/participantRoutes';
import type { PodLookupResult } from '../../../src/identity/drizzle/PodLookupRepository';

function pod(input: { baseUrl: string; webId?: string; webIds?: string[] }): PodLookupResult {
  return {
    podId: `pod-${input.baseUrl}`,
    accountId: 'account-1',
    baseUrl: input.baseUrl,
    ...(input.webId === undefined ? {} : { webId: input.webId }),
    ...(input.webIds === undefined ? {} : { webIds: input.webIds }),
  };
}

/** A deployment's registrations, as the repository would answer them. */
function routesOf(pods: readonly PodLookupResult[]): MatrixParticipantRoutes {
  return createParticipantRoutes({ pods: { listAllPods: async () => [ ...pods ] } });
}

describe('which Pod serves a server name', () => {
  it('derives the route from the registration the deployment already keeps', async () => {
    const routes = routesOf([
      pod({ baseUrl: 'https://pod-a.example/alice', webId: 'https://alice.example/profile/card#me' }),
      pod({ baseUrl: 'https://pod-b.example/bob/', webId: 'https://bob.example/profile/card#me' }),
    ]);

    // The server name is the WebID's host, and the Pod is the registered root, normalized so a
    // caller can join resource paths onto it without a second spelling of the same Pod.
    await expect(routes.route('alice.example')).resolves.toEqual({
      kind: 'served',
      route: { webId: 'https://alice.example/profile/card#me', podUrl: 'https://pod-a.example/alice/' },
    });
    await expect(routes.route('bob.example')).resolves.toEqual({
      kind: 'served',
      route: { webId: 'https://bob.example/profile/card#me', podUrl: 'https://pod-b.example/bob/' },
    });
  });

  it('reports a name it serves no participant for, rather than guessing a Pod', async () => {
    const routes = routesOf([ pod({ baseUrl: 'https://pod-a.example/alice/', webId: 'https://alice.example/card#me' }) ]);
    await expect(routes.route('bob.example')).resolves.toEqual({ kind: 'unknown' });
    await expect(routes.route('alice.example:8448')).resolves.toEqual({ kind: 'unknown' });
  });

  it('refuses a name two participants claim instead of writing into one of their Pods', async () => {
    const routes = routesOf([
      pod({ baseUrl: 'https://pod-a.example/one/', webId: 'https://alice.example/one#me' }),
      pod({ baseUrl: 'https://pod-a.example/two/', webId: 'https://alice.example/two#me' }),
    ]);
    const answer = await routes.route('alice.example');
    expect(answer.kind).toBe('ambiguous');
    expect(answer.kind === 'ambiguous' ? answer.reason : '').toMatch(/2 participants/u);
  });

  it('refuses a participant with several Pods, as the key-custody policy does', async () => {
    const routes = routesOf([
      pod({ baseUrl: 'https://pod-a.example/alice/', webId: 'https://alice.example/card#me' }),
      pod({ baseUrl: 'https://pod-other.example/alice/', webId: 'https://alice.example/card#me' }),
    ]);
    const answer = await routes.route('alice.example');
    expect(answer.kind).toBe('ambiguous');
    expect(answer.kind === 'ambiguous' ? answer.reason : '').toMatch(/2 Pods/u);
  });

  it('serves every WebID a registration covers, and skips the ones that cannot be a server', async () => {
    const routes = routesOf([
      pod({ baseUrl: 'https://pod-a.example/shared/', webIds: [ 'https://alice.example/card#me', 'https://carol.example/card#me' ] }),
      pod({ baseUrl: 'https://pod-a.example/broken/', webId: 'not a webid' }),
    ]);
    const { served, ambiguous } = await routes.routes();
    expect([ ...served.keys() ].sort()).toEqual([ 'alice.example', 'carol.example' ]);
    expect(ambiguous).toEqual([]);
  });

  it('serves a name from one registration when the same Pod is listed twice', async () => {
    // Two rows for the same Pod and participant is one route, not an ambiguity: the answer a
    // caller would get is the same either way.
    const routes = routesOf([
      pod({ baseUrl: 'https://pod-a.example/alice/', webId: 'https://alice.example/card#me' }),
      pod({ baseUrl: 'https://pod-a.example/alice', webId: 'https://alice.example/card#me' }),
    ]);
    await expect(routes.route('alice.example')).resolves.toEqual({
      kind: 'served',
      route: { webId: 'https://alice.example/card#me', podUrl: 'https://pod-a.example/alice/' },
    });
  });

  it('answers with no routes at all when the deployment has registered no Pods', async () => {
    const routes = routesOf([]);
    await expect(routes.route('alice.example')).resolves.toEqual({ kind: 'unknown' });
    await expect(routes.routes()).resolves.toEqual({ served: new Map(), ambiguous: [] });
  });
});
