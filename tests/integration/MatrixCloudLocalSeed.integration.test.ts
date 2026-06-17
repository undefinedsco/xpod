import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';
import { setupAccount, type AccountSetup } from './helpers/solidAccount';

const runCloudLocalSmoke = process.env.XPOD_RUN_CLOUD_LOCAL_MATRIX_SMOKE === 'true';
const maybeDescribe = runCloudLocalSmoke ? describe : describe.skip;
const cloudBaseUrl = process.env.XPOD_CLOUD_MATRIX_SMOKE_ISSUER ?? 'https://id.undefineds.co';
const serviceToken = 'test-local-sp-service-token';

function podNameFromWebId(webId: string): string {
  const [podName] = new URL(webId).pathname.split('/').filter(Boolean);
  if (!podName) {
    throw new Error('Cannot derive Pod name from Cloud WebID');
  }
  return podName;
}

function matrixAuthHeaders(account: AccountSetup, baseUrl: string): Record<string, string> {
  const apiKey = `sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64')}`;
  const url = new URL(baseUrl);
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-forwarded-proto': url.protocol.replace(':', ''),
    'x-forwarded-host': url.host,
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

maybeDescribe('Matrix Cloud WebID + Local SP seed smoke', () => {
  let stack: XpodTestStack;

  beforeAll(async () => {
    stack = new XpodTestStack();
    await stack.start('local', {
      transport: 'port',
      open: false,
      apiOpen: false,
      authMode: 'allow-all',
      env: {
        oidcIssuer: cloudBaseUrl,
        XPOD_SERVICE_TOKEN: serviceToken,
        CLOUDFLARE_TUNNEL_TOKEN: undefined,
        LINX_TUNNEL_PROVIDER: undefined,
      },
      logLevel: 'error',
    });
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  it('uses Cloud credentials while storing Matrix room data in the seeded Local SP Pod', async () => {
    const account = await setupAccount(cloudBaseUrl, `mx-local-${Date.now().toString(36)}`);
    expect(account).not.toBeNull();
    const podName = podNameFromWebId(account!.webId);

    const provision = await stack.runtimeFetch('/provision/pods', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ podName, webId: account!.webId }),
    });
    expect([200, 201]).toContain(provision.status);
    const provisionBody = await provision.json() as { podUrl?: string };
    expect(provisionBody.podUrl).toContain(`/${podName}/`);

    const publicHeaders = {
      'x-forwarded-proto': new URL(stack.baseUrl).protocol.replace(':', ''),
      'x-forwarded-host': new URL(stack.baseUrl).host,
    };
    await expect(readJson(await stack.runtimeFetch('/.well-known/matrix/client', { headers: publicHeaders })))
      .resolves.toMatchObject({ 'm.homeserver': { base_url: stack.baseUrl.replace(/\/$/, '') } });
    await expect(readJson(await stack.runtimeFetch('/_matrix/client/versions', { headers: publicHeaders })))
      .resolves.toMatchObject({ unstable_features: { 'co.undefineds.matrix.pod_storage': true } });

    const headers = matrixAuthHeaders(account!, stack.baseUrl);
    const whoami = await readJson(await stack.runtimeFetch('/_matrix/client/v3/account/whoami', { headers }));
    expect(whoami.user_id).toContain(`:${new URL(stack.baseUrl).host}`);

    const room = await readJson(await stack.runtimeFetch('/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Seeded Local room', topic: 'Cloud WebID + Local SP' }),
    }));
    expect(room.room_id).toContain(`:${new URL(stack.baseUrl).host}`);

    const joined = await readJson(await stack.runtimeFetch('/_matrix/client/v3/joined_rooms', { headers }));
    expect(joined.joined_rooms).toContain(room.room_id);

    const txnId = `txn-${Date.now().toString(36)}`;
    const sent = await readJson(await stack.runtimeFetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello from cloud-local seeded integration' }),
      },
    ));
    expect(sent.event_id).toBeTruthy();

    const sync = await readJson(await stack.runtimeFetch('/_matrix/client/v3/sync?timeout=0', { headers }));
    expect(sync.rooms?.join?.[room.room_id]).toBeTruthy();
  }, 180_000);
});
