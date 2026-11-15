import type { ApiContainerConfig } from './types';

/**
 * Canonical storage (Pod) base URL for a Local runtime.
 *
 * This is the SAME authority the Local Pod provisioning API uses, and it is the
 * only URL a Local managed runtime may treat as its own canonical resource
 * origin. A Cloud-issued `publicUrl` wins over the loopback `solidBaseUrl`,
 * because managed Pods really live at the Cloud-issued https origin.
 *
 * Deliberately NOT the OIDC issuer: DPoP `htu` binds to the RESOURCE request
 * URI, never to the issuer origin.
 */
export function resolveLocalStorageProviderBaseUrl(
  config: Pick<ApiContainerConfig, 'publicUrl' | 'solidBaseUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredUrl = env.XPOD_PUBLIC_URL
    ?? config.publicUrl
    ?? config.solidBaseUrl
    ?? env.CSS_BASE_URL
    ?? 'http://localhost:3000/';
  const url = new URL(configuredUrl);
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.toString();
}
