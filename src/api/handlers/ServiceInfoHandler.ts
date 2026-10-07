import type { ApiServer } from '../ApiServer';

interface ServiceInfo {
  edition: 'cloud' | 'local';
  managed: boolean;
  publicUrl?: string;
  oidcIssuer?: string;
}

function displayUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Read from the deployment owner on each request; never duplicate provisioning state. */
export function registerServiceInfoRoute(server: ApiServer, read: () => ServiceInfo): void {
  server.get('/api/service-info', async (_req, res) => {
    const info = read();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      edition: info.edition,
      managed: info.managed,
      publicUrl: displayUrl(info.publicUrl) ?? null,
      ...(info.managed ? { oidcIssuer: displayUrl(info.oidcIssuer) } : {}),
    }));
  }, { public: true });
}
