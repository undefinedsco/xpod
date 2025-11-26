import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { Response } from 'undici';
import { Session } from '@inrupt/solid-client-authn-node';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.SOLID_ENV_FILE ?? '.env.local' });

const baseUrl = process.env.XPOD_LOCAL_BASE_URL ?? 'http://localhost:3000/';
const clientId = process.env.SOLID_CLIENT_ID;
const clientSecret = process.env.SOLID_CLIENT_SECRET;
const oidcIssuer = process.env.SOLID_OIDC_ISSUER ?? baseUrl;
const webId = process.env.WEBID;
const baseContainer = deriveBaseContainer();

function joinUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

const SUCCESS_STATUS = new Set([ 200, 201, 202, 204, 205, 207 ]);

async function assertSuccess(response: Response, step: string): Promise<void> {
  if (!SUCCESS_STATUS.has(response.status)) {
    const text = await response.clone().text();
    throw new Error(`${step} failed with status ${response.status}: ${text}`);
  }
}

const shouldRunIntegration = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true' && clientId && clientSecret && oidcIssuer;
const suite = shouldRunIntegration ? describe : describe.skip;

suite('Local CSS CRUD integration', () => {
  let session: Session;
  let doFetch: typeof fetch;

  beforeAll(async () => {
    try {
      const health = await fetch(baseUrl, { method: 'HEAD' });
      if (!health.ok && !SUCCESS_STATUS.has(health.status) && ![ 401, 404, 405 ].includes(health.status)) {
        throw new Error(`Server at ${baseUrl} responded with status ${health.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach CSS instance at ${baseUrl}. Start it with "yarn local" first. Details: ${message}`);
    }

    session = new Session();
    await session.login({
      clientId: clientId!,
      clientSecret: clientSecret!,
      oidcIssuer,
      tokenType: process.env.SOLID_TOKEN_TYPE === 'Bearer' ? 'Bearer' : 'DPoP',
    });
    doFetch = session.fetch.bind(session);

    const baseHead = await doFetch(baseContainer, { method: 'HEAD' });
    if (baseHead.status === 404) {
      const createBase = await doFetch(baseContainer, {
        method: 'PUT',
        headers: {
          'content-type': 'text/turtle',
          'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
      await assertSuccess(createBase, 'create base container');
    }
  });

  afterAll(async () => {
    if (session?.info.isLoggedIn) {
      await session.logout().catch(() => undefined);
    }
  });

  it('performs CRUD across containers and documents', async () => {
    const uniqueId = `it-${Date.now()}`;
    const containerPath = joinUrl(baseContainer, `${uniqueId}/`);
    const turtlePath = joinUrl(baseContainer, `${uniqueId}/profile.ttl`);
    const jsonPath = joinUrl(baseContainer, `${uniqueId}/settings.json`);

    let containerCreated = false;
    let turtleCreated = false;
    let jsonCreated = false;

    try {
      const createContainer = await doFetch(containerPath, {
        method: 'PUT',
        headers: {
          'content-type': 'text/turtle',
          'link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
        },
        body: '',
      });
      await assertSuccess(createContainer, 'create container');
      containerCreated = true;

      const turtleBody = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<${turtlePath}> foaf:name "Integration User".`;
      const putTurtle = await doFetch(turtlePath, {
        method: 'PUT',
        headers: {
          'content-type': 'text/turtle',
        },
        body: turtleBody,
      });
      await assertSuccess(putTurtle, 'put turtle');
      turtleCreated = true;

      const getTurtle = await doFetch(turtlePath, { method: 'GET', headers: { accept: 'text/turtle' } });
      await assertSuccess(getTurtle, 'get turtle');
      const turtleText = await getTurtle.text();
      expect(turtleText).toContain('Integration User');

      const jsonPayload = JSON.stringify({ theme: 'dark', updatedAt: new Date().toISOString() });
      const putJson = await doFetch(jsonPath, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: jsonPayload,
      });
      await assertSuccess(putJson, 'put json');
      jsonCreated = true;

      const getJson = await doFetch(jsonPath, { method: 'GET', headers: { accept: 'application/json' } });
      await assertSuccess(getJson, 'get json');
      const json = await getJson.json();
      expect(json.theme).toBe('dark');

      const deleteJson = await doFetch(jsonPath, { method: 'DELETE' });
      await assertSuccess(deleteJson, 'delete json');
      jsonCreated = false;

      const deleteTurtle = await doFetch(turtlePath, { method: 'DELETE' });
      await assertSuccess(deleteTurtle, 'delete turtle');
      turtleCreated = false;

      if (webId) {
        const getProfile = await doFetch(webId, { method: 'GET', headers: { accept: 'text/turtle' } });
        await assertSuccess(getProfile, 'get profile');
      }

      const deleteContainer = await doFetch(containerPath, { method: 'DELETE' });
      await assertSuccess(deleteContainer, 'delete container');
      containerCreated = false;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (jsonCreated) {
        await doFetch(jsonPath, { method: 'DELETE' }).catch(() => undefined);
      }
      if (turtleCreated) {
        await doFetch(turtlePath, { method: 'DELETE' }).catch(() => undefined);
      }
      if (containerCreated) {
        await doFetch(containerPath, { method: 'DELETE' }).catch(() => undefined);
      }
    }
  });
});

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`;
}

function deriveBaseContainer(): string {
  if (process.env.SOLID_BASE_CONTAINER) {
    return ensureTrailingSlash(process.env.SOLID_BASE_CONTAINER);
  }
  if (webId) {
    const webIdUrl = new URL(webId);
    webIdUrl.hash = '';
    let podPath = webIdUrl.pathname;
    if (podPath.endsWith('/profile/card')) {
      podPath = podPath.slice(0, -'/profile/card'.length);
    } else if (podPath.endsWith('/card')) {
      podPath = podPath.slice(0, -'/card'.length);
    }
    if (!podPath.endsWith('/')) {
      const segments = podPath.split('/').filter(Boolean);
      podPath = segments.length > 0 ? `/${segments[0]}/` : '/';
    }
    const podRoot = ensureTrailingSlash(`${webIdUrl.origin}${podPath}`);
    return ensureTrailingSlash(joinUrl(podRoot, 'integration/'));
  }
  return ensureTrailingSlash(joinUrl(baseUrl, 'integration/'));
}
