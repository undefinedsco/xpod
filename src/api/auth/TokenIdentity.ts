export type TokenIdentityResponse = {
  access_token?: unknown;
  webid?: unknown;
  webId?: unknown;
};

export function extractAuthoritativeWebIdFromTokenResponse(response: TokenIdentityResponse): string | undefined {
  const bodyWebId = extractString(response.webid) ?? extractString(response.webId);
  if (bodyWebId) {
    return bodyWebId;
  }
  const accessToken = extractString(response.access_token);
  if (!accessToken) {
    return undefined;
  }
  return extractWebIdFromJwtPayload(accessToken);
}

function extractWebIdFromJwtPayload(jwt: string): string | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[1]) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
    return extractString(payload.webid) ?? extractString(payload.webId) ?? extractString(payload.sub);
  } catch {
    return undefined;
  }
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
