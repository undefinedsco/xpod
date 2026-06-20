import {
  createSignaledManagedClientFetch,
  type SignaledManagedClientFetchOptions,
} from './ManagedClientFetch';
import type { AccessRoute } from './types';

export interface ManagedClientP2PSmokeOptions extends SignaledManagedClientFetchOptions {
  resourceUrl: string;
  requestInit?: RequestInit;
}

export interface ManagedClientP2PSmokeResult {
  ok: boolean;
  route: AccessRoute;
  resourceUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export async function runManagedClientP2PSmoke(
  options: ManagedClientP2PSmokeOptions,
): Promise<ManagedClientP2PSmokeResult> {
  const { resourceUrl, requestInit, ...fetchOptions } = options;
  const managed = await createSignaledManagedClientFetch(fetchOptions);
  try {
    const response = await managed.fetch(resourceUrl, requestInit);
    return {
      ok: response.ok,
      route: managed.route,
      resourceUrl,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      body: await response.text(),
    };
  } finally {
    managed.close();
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
