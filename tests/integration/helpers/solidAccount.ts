import {
  buildAuthenticatedFetch,
  createDpopHeader,
  generateDpopKeyPair,
} from "@inrupt/solid-client-authn-core";
import dns from "node:dns";

// Docker 内部主机名 → 127.0.0.1，让宿主机能访问 presigned URL
const DOCKER_HOSTS: Record<string, string> = { minio: "127.0.0.1" };
const _origLookup = dns.lookup;
(dns as any).lookup = (hostname: string, ...args: any[]) => {
  const mapped = DOCKER_HOSTS[hostname];
  return mapped
    ? (_origLookup as any).call(dns, mapped, ...args)
    : (_origLookup as any).call(dns, hostname, ...args);
};

export interface AccountSetup {
  clientId: string;
  clientSecret: string;
  webId: string;
  podUrl: string;
  issuer: string;
  /** Credentials are exposed only for hermetic browser acceptance flows. */
  email?: string;
  password?: string;
}

export interface ClientCredentialsSolidSession {
  info: {
    sessionId: string;
    isLoggedIn: boolean;
    webId?: string;
    clientAppId?: string;
    expirationDate?: number;
  };
  fetch: typeof fetch;
  logout: () => Promise<void>;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sameIssuerScope(candidate: URL, fallback: URL): boolean {
  return candidate.protocol === fallback.protocol &&
    candidate.hostname === fallback.hostname &&
    candidate.port === fallback.port &&
    ensureTrailingSlash(candidate.pathname) === ensureTrailingSlash(fallback.pathname);
}

function alignToBaseOrigin(raw: string | undefined, baseUrl: string, fallbackPath: string): string {
  const base = new URL(baseUrl);

  if (!raw) {
    return new URL(fallbackPath, base).toString();
  }

  try {
    const source = new URL(raw);
    if (source.origin === base.origin) {
      return source.toString();
    }

    return new URL(source.pathname + source.search + source.hash, base).toString();
  } catch {
    return new URL(fallbackPath, base).toString();
  }
}

function derivePodUrlFromWebId(webId: string, baseUrl: string): string {
  const profileUrl = webId.split("#")[0];
  if (profileUrl.endsWith("/profile/card")) {
    return `${profileUrl.slice(0, -"/profile/card".length)}/`;
  }

  try {
    const url = new URL(profileUrl);
    const [podSegment] = url.pathname.split("/").filter(Boolean);
    return podSegment ? new URL(`/${podSegment}/`, baseUrl).toString() : ensureTrailingSlash(baseUrl);
  } catch {
    return ensureTrailingSlash(baseUrl);
  }
}

export function getConfiguredAccount(baseUrl?: string): AccountSetup | null {
  const clientId = (process.env.TEST_SOLID_CLIENT_ID ?? process.env.SOLID_CLIENT_ID)?.trim();
  const clientSecret = (process.env.TEST_SOLID_CLIENT_SECRET ?? process.env.SOLID_CLIENT_SECRET)?.trim();
  const candidateBase = ensureTrailingSlash(baseUrl || process.env.CSS_BASE_URL || (process.env.TEST_SOLID_OIDC_ISSUER ?? process.env.SOLID_OIDC_ISSUER) || 'http://localhost/');
  const defaultPodId = (process.env.TEST_SOLID_POD_ID ?? process.env.SOLID_TEST_POD_ID) || 'test';

  if (!clientId || !clientSecret) {
    return null;
  }

  const issuer = ensureTrailingSlash(alignToBaseOrigin(process.env.TEST_SOLID_OIDC_ISSUER ?? process.env.SOLID_OIDC_ISSUER, candidateBase, '/'));
  const webId = alignToBaseOrigin(process.env.TEST_SOLID_WEBID ?? process.env.SOLID_WEBID, candidateBase, `/${defaultPodId}/profile/card#me`);
  const podUrl = derivePodUrlFromWebId(webId, candidateBase);

  return {
    clientId,
    clientSecret,
    webId,
    podUrl,
    issuer,
  };
}

type DockerServiceHost = {
  hostHeader: string;
  internalOrigin: string;
  externalOrigin: string;
};

function dockerServiceForBaseUrl(baseUrl: string): DockerServiceHost | null {
  const cloudPort = process.env.CLOUD_PORT || '6300';
  const cloudBPort = process.env.CLOUD_B_PORT || '6400';
  if (baseUrl.includes(`localhost:${cloudPort}`)) {
    return {
      hostHeader: `cloud:${cloudPort}`,
      internalOrigin: `http://cloud:${cloudPort}`,
      externalOrigin: `http://localhost:${cloudPort}`,
    };
  }
  if (baseUrl.includes(`localhost:${cloudBPort}`)) {
    return {
      hostHeader: `cloud_b:${cloudBPort}`,
      internalOrigin: `http://cloud_b:${cloudBPort}`,
      externalOrigin: `http://localhost:${cloudBPort}`,
    };
  }
  return null;
}

function normalizeServiceUrl(rawUrl: string, baseUrl: string): string {
  const service = dockerServiceForBaseUrl(baseUrl);
  if (!service) {
    return rawUrl;
  }

  // Avoid regex escaping footguns in tests.
  return rawUrl.split(service.internalOrigin).join(service.externalOrigin);
}

export function normalizeAccountControlUrl(rawUrl: string, baseUrl: string): string {
  const normalized = normalizeServiceUrl(rawUrl, baseUrl);
  try {
    const control = new URL(normalized);
    const base = new URL(baseUrl);
    if (control.origin !== base.origin) {
      return new URL(`${control.pathname}${control.search}${control.hash}`, base).toString();
    }
  } catch {
    return new URL(rawUrl, baseUrl).toString();
  }
  return normalized;
}

function hostHeaderFor(baseUrl: string): Record<string, string> {
  const service = dockerServiceForBaseUrl(baseUrl);
  return service ? { Host: service.hostHeader } : {};
}

export async function discoverOidcIssuerFromWebId(webId: string, fallbackIssuer: string): Promise<string> {
  const normalizedFallbackIssuer = ensureTrailingSlash(fallbackIssuer);
  try {
    const profileUrl = webId.split("#")[0];
    const res = await fetch(profileUrl, {
      headers: { Accept: "text/turtle, application/ld+json;q=0.9, application/rdf+xml;q=0.8" },
    });
    if (!res.ok) {
      return normalizedFallbackIssuer;
    }

    const body = await res.text();
    const fullIriMatch = body.match(/<http:\/\/www\.w3\.org\/ns\/solid\/terms#oidcIssuer>\s*<([^>]+)>/);
    const prefixedMatch = body.match(/solid:oidcIssuer\s*<([^>]+)>/);
    const discoveredRaw = fullIriMatch?.[1] ?? prefixedMatch?.[1];
    if (!discoveredRaw) {
      return normalizedFallbackIssuer;
    }

    const discoveredUrl = new URL(discoveredRaw, profileUrl);
    const fallbackUrl = new URL(fallbackIssuer);
    if (!sameIssuerScope(discoveredUrl, fallbackUrl)) {
      return normalizedFallbackIssuer;
    }

    const discoveredIssuer = ensureTrailingSlash(discoveredUrl.toString());
    const openidRes = await fetch(`${discoveredIssuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!openidRes.ok) {
      return normalizedFallbackIssuer;
    }

    return discoveredIssuer;
  } catch {
    return normalizedFallbackIssuer;
  }
}

async function setupAccountOnce(baseUrl: string, prefix: string): Promise<AccountSetup | null> {
  const suffix = Date.now().toString(36);
  const normalizedPrefix = (prefix || 'test')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'test';
  const shortPrefix = normalizedPrefix.slice(0, 8).replace(/^-|-$/g, '') || 'test';
  const emailPrefix = normalizedPrefix.slice(0, 24) || 'test';
  const email = `${emailPrefix}-${suffix}@test.com`;
  const password = 'test123456';
  const podName = `${shortPrefix}-${suffix}`;
  const routingHeaders = hostHeaderFor(baseUrl);
  const tag = `[setupAccount:${prefix}]`;

  // Step 1: Create account
  const createRes = await fetch(`${baseUrl}/.account/account/`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...routingHeaders,
    },
    body: JSON.stringify({}),
  });
  if (!createRes.ok) {
    console.error(`${tag} create account failed: ${createRes.status} ${await createRes.text().catch(() => '')}`);
    return null;
  }

  const createData = await createRes.json() as { authorization: string };
  const authorization = createData.authorization;

  // Step 2: Get controls
  const controlsRes = await fetch(`${baseUrl}/.account/`, {
    headers: {
      Accept: "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
      ...routingHeaders,
    },
  });
  if (!controlsRes.ok) {
    console.error(`${tag} get controls failed: ${controlsRes.status}`);
    return null;
  }

  const controls = await controlsRes.json() as {
    controls?: {
      password?: { create?: string };
      account?: { pod?: string; clientCredentials?: string };
    };
  };

  // Step 3: Create password login
  const passwordUrl = controls.controls?.password?.create;
  if (passwordUrl) {
    const pwRes = await fetch(normalizeAccountControlUrl(passwordUrl, baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `CSS-Account-Token ${authorization}`,
        ...routingHeaders,
      },
      body: JSON.stringify({ email, password }),
    });
    if (!pwRes.ok) {
      console.error(`${tag} create password failed: ${pwRes.status} ${await pwRes.text().catch(() => '')}`);
    }
  }

  // Step 4: Create pod
  const podCreateUrl = controls.controls?.account?.pod;
  if (!podCreateUrl) {
    console.error(`${tag} no pod create URL in controls: ${JSON.stringify(controls.controls)}`);
    return null;
  }

  const podRes = await fetch(normalizeAccountControlUrl(podCreateUrl, baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
      ...routingHeaders,
    },
    body: JSON.stringify({ name: podName }),
  });
  if (!podRes.ok) {
    console.error(`${tag} create pod failed: ${podRes.status} ${await podRes.text().catch(() => '')}`);
    return null;
  }

  const podInfo = await podRes.json() as { webId?: string; pod?: string };
  const webId = normalizeServiceUrl(podInfo.webId ?? `${baseUrl}/${podName}/profile/card#me`, baseUrl);
  const podUrl = normalizeServiceUrl(podInfo.pod ?? `${baseUrl}/${podName}/`, baseUrl);

  // Step 5: Create client credentials
  const clientCredsUrl = controls.controls?.account?.clientCredentials;
  if (!clientCredsUrl) {
    console.error(`${tag} no clientCredentials URL in controls: ${JSON.stringify(controls.controls)}`);
    return null;
  }

  const credsRes = await fetch(normalizeAccountControlUrl(clientCredsUrl, baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `CSS-Account-Token ${authorization}`,
      ...routingHeaders,
    },
    body: JSON.stringify({ name: `${prefix}-client`, webId }),
  });
  if (!credsRes.ok) {
    console.error(`${tag} create clientCredentials failed: ${credsRes.status} ${await credsRes.text().catch(() => '')}`);
    return null;
  }

  const creds = await credsRes.json() as { id: string; secret: string };
  const issuer = await discoverOidcIssuerFromWebId(webId, baseUrl);

  return {
    clientId: creds.id,
    clientSecret: creds.secret,
    webId,
    podUrl,
    issuer,
    email,
    password,
  };
}

export async function setupAccount(baseUrl: string, prefix: string): Promise<AccountSetup | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const account = await setupAccountOnce(baseUrl, prefix);
    if (account) {
      return account;
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return null;
}



function normalizeTokenType(value: unknown): 'Bearer' | 'DPoP' {
  return typeof value === 'string' && value.toUpperCase() === 'DPOP' ? 'DPoP' : 'Bearer';
}

function createAuthorizedFetch(
  accessToken: string,
  tokenType: 'Bearer' | 'DPoP',
  dpopKey?: Awaited<ReturnType<typeof generateDpopKeyPair>>,
  transportFetch: typeof fetch = fetch,
): typeof fetch {
  if (tokenType === 'DPoP' && dpopKey) {
    return buildAuthenticatedFetch(accessToken, {
      dpopKey,
      fetch: transportFetch,
    });
  }

  return async(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `${tokenType} ${accessToken}`);
    }

    return transportFetch(input, {
      ...init,
      headers,
    });
  };
}

async function discoverOidcConfiguration(issuer: string): Promise<{
  issuer?: string;
  token_endpoint?: string;
}> {
  const discoveryUrl = new URL('.well-known/openid-configuration', ensureTrailingSlash(issuer));
  const response = await fetch(discoveryUrl);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status} ${await response.text().catch(() => '')}`);
  }
  return response.json() as Promise<{ issuer?: string; token_endpoint?: string }>;
}

function requestUrlForDiscoveredEndpoint(endpoint: string, issuer: string): string {
  const endpointUrl = new URL(endpoint);
  const issuerUrl = new URL(ensureTrailingSlash(issuer));

  if (issuerUrl.hostname === 'localhost' || issuerUrl.hostname === '127.0.0.1' || issuerUrl.hostname === '[::1]') {
    return new URL(`${endpointUrl.pathname}${endpointUrl.search}${endpointUrl.hash}`, issuerUrl).toString();
  }

  return endpointUrl.toString();
}

export async function getClientCredentialsToken(account: AccountSetup): Promise<{
  accessToken: string;
  tokenType: 'Bearer' | 'DPoP';
  expiresAt?: number;
}> {
  const discovery = await discoverOidcConfiguration(account.issuer);
  const canonicalTokenEndpoint = discovery.token_endpoint ?? new URL('.oidc/token', account.issuer).toString();
  const tokenRequestUrl = requestUrlForDiscoveredEndpoint(canonicalTokenEndpoint, account.issuer);
  const dpopKey = await generateDpopKeyPair();
  const response = await fetch(normalizeServiceUrl(tokenRequestUrl, account.issuer), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${account.clientId}:${account.clientSecret}`, 'utf8').toString('base64')}`,
      DPoP: await createDpopHeader(canonicalTokenEndpoint, 'POST', dpopKey),
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'webid',
    }),
  });

  if (!response.ok) {
    throw new Error(`Client credentials token request failed: ${response.status} ${await response.text().catch(() => '')}`);
  }

  const token = await response.json() as { access_token?: string; token_type?: string; expires_in?: number };
  if (!token.access_token) {
    throw new Error(`Client credentials token response missing access_token: ${JSON.stringify(token)}`);
  }

  const expiresAt = typeof token.expires_in === 'number'
    ? Date.now() + token.expires_in * 1000
    : undefined;

  return {
    accessToken: token.access_token,
    tokenType: normalizeTokenType(token.token_type),
    expiresAt,
  };
}

export async function loginWithClientCredentials(
  account: AccountSetup,
  authenticatedTransport: typeof fetch = fetch,
): Promise<ClientCredentialsSolidSession> {
  const discovery = await discoverOidcConfiguration(account.issuer);
  const canonicalTokenEndpoint = discovery.token_endpoint ?? new URL('.oidc/token', account.issuer).toString();
  const tokenRequestUrl = requestUrlForDiscoveredEndpoint(canonicalTokenEndpoint, account.issuer);
  const dpopKey = await generateDpopKeyPair();
  const response = await fetch(normalizeServiceUrl(tokenRequestUrl, account.issuer), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${account.clientId}:${account.clientSecret}`, 'utf8').toString('base64')}`,
      DPoP: await createDpopHeader(canonicalTokenEndpoint, 'POST', dpopKey),
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'webid',
    }),
  });

  if (!response.ok) {
    throw new Error(`Client credentials token request failed: ${response.status} ${await response.text().catch(() => '')}`);
  }

  const token = await response.json() as { access_token?: string; token_type?: string; expires_in?: number };
  if (!token.access_token) {
    throw new Error(`Client credentials token response missing access_token: ${JSON.stringify(token)}`);
  }

  const tokenType = normalizeTokenType(token.token_type);
  const expiresAt = typeof token.expires_in === 'number'
    ? Date.now() + token.expires_in * 1000
    : undefined;

  return {
    info: {
      sessionId: `client-credentials-${Date.now().toString(36)}`,
      isLoggedIn: true,
      webId: account.webId,
      clientAppId: account.clientId,
      expirationDate: expiresAt,
    },
    fetch: createAuthorizedFetch(
      token.access_token,
      tokenType,
      tokenType === 'DPoP' ? dpopKey : undefined,
      authenticatedTransport,
    ),
    logout: async() => undefined,
  };
}
