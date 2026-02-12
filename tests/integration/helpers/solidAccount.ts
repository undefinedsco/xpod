import { Session } from "@inrupt/solid-client-authn-node";

export interface AccountSetup {
  clientId: string;
  clientSecret: string;
  webId: string;
  podUrl: string;
  issuer: string;
}

function isCloudHost(baseUrl: string): boolean {
  return baseUrl.includes("localhost:6300");
}

function normalizeServiceUrl(rawUrl: string, baseUrl: string): string {
  if (isCloudHost(baseUrl)) {
    return rawUrl.replace(/http:\/\/cloud:6300/g, "http://localhost:6300");
  }
  return rawUrl;
}

function hostHeaderFor(baseUrl: string): Record<string, string> {
  return isCloudHost(baseUrl) ? { Host: "cloud:6300" } : {};
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
  try {
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

    const createRes = await fetch(`${baseUrl}/.account/account/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...routingHeaders },
      body: JSON.stringify({}),
    });
    if (!createRes.ok) {
      return null;
    }

    const createData = await createRes.json() as { authorization: string };
    const authorization = createData.authorization;

    const controlsRes = await fetch(`${baseUrl}/.account/`, {
      headers: {
        Authorization: `CSS-Account-Token ${authorization}`,
        ...routingHeaders,
      },
    });
    if (!controlsRes.ok) {
      return null;
    }

    const controls = await controlsRes.json() as {
      controls?: {
        password?: { create?: string };
        account?: { pod?: string; clientCredentials?: string };
      };
    };

    const passwordUrl = controls.controls?.password?.create;
    if (passwordUrl) {
      await fetch(normalizeServiceUrl(passwordUrl, baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `CSS-Account-Token ${authorization}`,
          ...routingHeaders,
        },
        body: JSON.stringify({ email, password: "test123456" }),
      });
    }

    const podCreateUrl = controls.controls?.account?.pod;
    if (!podCreateUrl) {
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
      return null;
    }

    const podInfo = await podRes.json() as { webId?: string; pod?: string };
    const webId = normalizeServiceUrl(podInfo.webId ?? `${baseUrl}/${podName}/profile/card#me`, baseUrl);
    const podUrl = normalizeServiceUrl(podInfo.pod ?? `${baseUrl}/${podName}/`, baseUrl);

    const clientCredsUrl = controls.controls?.account?.clientCredentials;
    if (!clientCredsUrl) {
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
  } catch {
    return null;
  }
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

export async function loginWithClientCredentials(account: AccountSetup): Promise<Session> {
  const session = new Session();
  await session.login({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    oidcIssuer: account.issuer,
    tokenType: "DPoP",
  });
  return session;
}
