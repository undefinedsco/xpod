import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Provider, { type Configuration } from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mainConfig = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../config/main.json', import.meta.url)), 'utf8',
));
const oidcConfig = mainConfig['@graph'].find((entry: { overrideInstance?: { '@id'?: string } }) =>
  entry.overrideInstance?.['@id'] === 'urn:solid-server:default:IdentityProviderFactory',
).overrideParameters.config as Configuration;

describe('OIDC provisioning context', () => {
  let server: Server;
  let origin: string;
  let interactionParams: Record<string, unknown> | undefined;
  let serverError: Error | undefined;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provider = new Provider(origin, {
      ...oidcConfig,
      cookies: { ...oidcConfig.cookies, keys: ['oidc-provision-context-test'] },
      clients: [{
        client_id: 'local-settings',
        redirect_uris: ['http://127.0.0.1:5173/auth/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none',
      }],
      interactions: {
        url: (_context, interaction) => {
          interactionParams = interaction.params;
          return '/interaction';
        },
      },
    });
    provider.on('server_error', (error: Error) => { serverError = error; });
    server.on('request', provider.callback());
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function authorize(extra: Record<string, string> = {}): Promise<Record<string, unknown> | undefined> {
    interactionParams = undefined;
    serverError = undefined;
    const url = new URL('/auth', origin);
    url.search = new URLSearchParams({
      client_id: 'local-settings',
      redirect_uri: 'http://127.0.0.1:5173/auth/callback',
      response_type: 'code',
      scope: 'openid webid',
      code_challenge: createHash('sha256').update('test-verifier').digest('base64url'),
      code_challenge_method: 'S256',
      ...extra,
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status, serverError?.message).toBe(303);
    expect(response.headers.get('location')).toBe('/interaction');
    await response.body?.cancel();
    return interactionParams;
  }

  it('preserves the Local provision scope through the real OIDC parameter parser', async () => {
    const params = await authorize({ provisionCode: 'signed-local-provision-code' });

    expect(params?.provisionCode).toBe('signed-local-provision-code');
    // The redirect URI remains stable: provisioning is an authorization parameter.
    expect(params?.redirect_uri).toBe('http://127.0.0.1:5173/auth/callback');
  });

  it('leaves Cloud and Standalone authorization without a provision scope unchanged', async () => {
    const params = await authorize();

    expect(params?.client_id).toBe('local-settings');
    expect(params?.provisionCode).toBeUndefined();
  });

  it('does not retain arbitrary unregistered authorization parameters', async () => {
    const params = await authorize({ unregisteredStorage: 'http://wrong-storage.test/' });

    expect(params).not.toHaveProperty('unregisteredStorage');
  });
});
