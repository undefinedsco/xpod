import type { Session } from "@inrupt/solid-client-authn-node";
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
}

type DockerServiceHost = {
  hostHeader: string;
  internalOrigin: string;
  externalOrigin: string;
};

function dockerServiceForBaseUrl(baseUrl: string): DockerServiceHost | null {
  const cloudPort = process.env.CLOUD_PORT || '6300';
  const cloudBPort = process.env.CLOUD_B_PORT || '6400';
  // docker-compose.cluster.yml: cloud and cloud_b are exposed as localhost ports,
  // but CSS may return internal service URLs in controls.
  if (baseUrl.includes(`localhost:${cloudPort}`)) {
    return {
      hostHeader: "cloud:6300",
      internalOrigin: "http://cloud:6300",
      externalOrigin: `http://localhost:${cloudPort}`,
    };
  }
  if (baseUrl.includes(`localhost:${cloudBPort}`)) {
    return {
      hostHeader: "cloud_b:6400",
      internalOrigin: "http://cloud_b:6400",
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

function hostHeaderFor(baseUrl: string): Record<string, string> {
  const service = dockerServiceForBaseUrl(baseUrl);
  return service ? { Host: service.hostHeader } : {};
}

export async function discoverOidcIssuerFromWebId(webId: string, fallbackIssuer: string): Promise<string> {
  try {
    const profileUrl = webId.split("#")[0];
    const res = await fetch(profileUrl, {
      headers: { Accept: "text/turtle, application/ld+json;q=0.9, application/rdf+xml;q=0.8" },
    });
    if (!res.ok) {
      return fallbackIssuer;
    }

    const body = await res.text();
    const fullIriMatch = body.match(/<http:\/\/www\.w3\.org\/ns\/solid\/terms#oidcIssuer>\s*<([^>]+)>/);
    const prefixedMatch = body.match(/solid:oidcIssuer\s*<([^>]+)>/);
    const discoveredRaw = fullIriMatch?.[1] ?? prefixedMatch?.[1];
    if (!discoveredRaw) {
      return fallbackIssuer;
    }

    const discoveredUrl = new URL(discoveredRaw, profileUrl);
    const fallbackUrl = new URL(fallbackIssuer);
    if (
      discoveredUrl.protocol !== fallbackUrl.protocol ||
      discoveredUrl.hostname !== fallbackUrl.hostname ||
      discoveredUrl.port !== fallbackUrl.port
    ) {
      return fallbackIssuer;
    }

    const discoveredIssuer = discoveredUrl.toString();
    const openidRes = await fetch(`${discoveredIssuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!openidRes.ok) {
      return fallbackIssuer;
    }

    return discoveredIssuer;
  } catch {
    return fallbackIssuer;
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
  const podName = `${shortPrefix}-${suffix}`;
  const routingHeaders = hostHeaderFor(baseUrl);
  const tag = `[setupAccount:${prefix}]`;

  // Step 1: Create account
  const createRes = await fetch(`${baseUrl}/.account/account/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...routingHeaders },
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
    const pwRes = await fetch(normalizeServiceUrl(passwordUrl, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `CSS-Account-Token ${authorization}`,
        ...routingHeaders,
      },
      body: JSON.stringify({ email, password: "test123456" }),
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

  const podRes = await fetch(normalizeServiceUrl(podCreateUrl, baseUrl), {
    method: "POST",
    headers: {
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

  const credsRes = await fetch(normalizeServiceUrl(clientCredsUrl, baseUrl), {
    method: "POST",
    headers: {
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

function createAuthorizedFetch(accessToken: string, tokenType: 'Bearer' | 'DPoP'): typeof fetch {
  return async(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `${tokenType} ${accessToken}`);
    }

    return fetch(input, {
      ...init,
      headers,
    });
  };
}

export async function getClientCredentialsToken(account: AccountSetup): Promise<{
  accessToken: string;
  tokenType: 'Bearer' | 'DPoP';
  expiresAt?: number;
}> {
  const issuer = account.issuer.replace(/\/$/, '');
  const tokenEndpoint = `${issuer}/.oidc/token`;
  const response = await fetch(normalizeServiceUrl(tokenEndpoint, account.issuer), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...hostHeaderFor(account.issuer),
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: account.clientId,
      client_secret: account.clientSecret,
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

export async function loginWithClientCredentials(account: AccountSetup): Promise<Session> {
  const token = await getClientCredentialsToken(account);
  const authFetch = createAuthorizedFetch(token.accessToken, token.tokenType);

  return {
    info: {
      sessionId: `direct-${Date.now()}`,
      isLoggedIn: true,
      webId: account.webId,
      expirationDate: token.expiresAt,
    },
    fetch: authFetch,
    logout: async() => undefined,
  } as unknown as Session;
}
