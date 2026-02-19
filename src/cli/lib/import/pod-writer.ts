/**
 * Write Turtle data to a Solid Pod.
 *
 * Supports two granularity modes:
 * - per-table: PUT the entire Turtle string as a single resource
 * - per-row:   PUT each row as a separate .ttl resource under a container
 *
 * Reuses css-account.ts for authentication.
 */

import { login, checkServer } from '../css-account';

export interface PodAuth {
  baseUrl: string;
  email: string;
  password: string;
}

interface PodContext {
  token: string;
  podUrl: string;
}

/**
 * Authenticate and resolve the Pod URL.
 */
export async function resolvePod(auth: PodAuth): Promise<PodContext> {
  const baseUrl = auth.baseUrl.endsWith('/') ? auth.baseUrl : `${auth.baseUrl}/`;

  if (!(await checkServer(baseUrl))) {
    throw new Error(`Cannot reach server at ${baseUrl}`);
  }

  const token = await login(auth.email, auth.password, baseUrl);
  if (!token) {
    throw new Error('Login failed. Check email/password.');
  }

  // Resolve pod URL from account info
  const accountRes = await fetch(`${baseUrl}.account/`, {
    headers: {
      Accept: 'application/json',
      Authorization: `CSS-Account-Token ${token}`,
    },
  });

  if (!accountRes.ok) {
    throw new Error('Failed to get account info.');
  }

  const accountData = (await accountRes.json()) as { pods?: Record<string, string> };
  const pods = accountData.pods;
  const podUrl = pods ? Object.values(pods)[0] : undefined;

  if (!podUrl) {
    throw new Error('No pod found for this account.');
  }

  return { token, podUrl };
}

/**
 * PUT a Turtle document to a Pod resource path.
 */
export async function putTurtle(
  ctx: PodContext,
  targetPath: string,
  turtle: string,
): Promise<void> {
  const url = `${ctx.podUrl}${targetPath.replace(/^\//, '')}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      Authorization: `CSS-Account-Token ${ctx.token}`,
    },
    body: turtle,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${url} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}
