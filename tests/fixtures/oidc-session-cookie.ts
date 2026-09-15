import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import Provider from 'oidc-provider';

// A real Bun HTTP server and the installed provider; no mocked response headers.
const remember = process.argv[2] === 'remember';
let provider: Provider;
const server = createServer((request, response) => {
  void (async () => {
    if (request.url?.startsWith('/interaction/')) {
      const details = await provider.interactionDetails(request, response);
      const grant = new provider.Grant({ accountId: 'fixture-user', clientId: 'fixture-client' });
      grant.addOIDCScope('openid');
      const grantId = await grant.save();
      await provider.interactionFinished(request, response, {
        login: { accountId: 'fixture-user', remember },
        consent: { grantId },
      }, { mergeWithLastSubmission: false });
      if (!details.uid) throw new Error('Missing real provider interaction');
      return;
    }
    provider.callback()(request, response);
  })().catch((error) => { response.statusCode = 500; response.end(String(error)); });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
const issuer = `http://127.0.0.1:${address.port}`;
provider = new Provider(issuer, {
  clients: [{ client_id: 'fixture-client', redirect_uris: [`${issuer}/callback`],
    response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }],
  cookies: { keys: ['fixture-cookie-signing-key'], long: { signed: true }, short: { signed: true } },
  ttl: { AccessToken: 3600, AuthorizationCode: 600, BackchannelAuthenticationRequest: 600,
    ClientCredentials: 600, DeviceCode: 600, Grant: 3600, IdToken: 3600,
    Interaction: 3600, RefreshToken: 3600, Session: 3600 },
  features: { devInteractions: { enabled: false } },
  interactions: { url: (_ctx, interaction) => `${issuer}/interaction/${interaction.uid}` },
  findAccount: async () => ({ accountId: 'fixture-user', claims: async () => ({ sub: 'fixture-user' }) }),
});

const cookies = new Map<string, string>();
const cookieMetadata = new Map<string, { name: string; persistent: boolean }>();
let interactionCount = 0;
try {
  const params = new URLSearchParams({ client_id: 'fixture-client', response_type: 'code',
    redirect_uri: `${issuer}/callback`, scope: 'openid', state: 'fixture-state',
    code_challenge: createHash('sha256').update('fixture-verifier-that-is-long-enough-for-pkce').digest('base64url'),
    code_challenge_method: 'S256' });
  let target = `${issuer}/auth?${params}`;
  let completed = false;
  for (let step = 0; step < 10; step += 1) {
    if (new URL(target).pathname.startsWith('/interaction/')) interactionCount += 1;
    const response = await fetch(target, { redirect: 'manual', headers: { Cookie: [...cookies.values()].join('; ') } });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      cookies.set(name, pair);
      cookieMetadata.set(name, { name, persistent: /;\s*(?:expires|max-age)=/i.test(cookie) });
    }
    const location = response.headers.get('location');
    if (!location || response.status < 300 || response.status >= 400) {
      throw new Error(`Authorization did not redirect (${response.status}): ${await response.text()}`);
    }
    target = new URL(location, issuer).href;
    if (new URL(target).pathname === '/callback') {
      if (!new URL(target).searchParams.has('code')) throw new Error('Authorization did not issue a code');
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error('Authorization did not finish');
  // A new browser process keeps persistent cookies and drops session cookies.
  const retainedCookies = [...cookies.entries()]
    .filter(([name]) => cookieMetadata.get(name)?.persistent)
    .map(([, pair]) => pair).join('; ');
  params.set('prompt', 'none');
  const restore = await fetch(`${issuer}/auth?${params}`, {
    redirect: 'manual', headers: { Cookie: retainedCookies },
  });
  const restoredLocation = new URL(restore.headers.get('location') ?? '/', issuer);
  const restoredWithoutInteraction = restoredLocation.pathname === '/callback'
    && restoredLocation.searchParams.has('code');
  console.log(JSON.stringify({ runtime: 'bun', interactionCount, completed,
    restoredWithoutInteraction,
    cookies: ['_session', '_session.sig'].map((name) => cookieMetadata.get(name)) }));
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
