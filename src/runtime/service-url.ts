export function connectHostForBindHost(bindHost?: string): string {
  const host = bindHost ?? '127.0.0.1';
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (host === '::' || host === '[::]' || host === '::0') {
    return '::1';
  }
  return host;
}

/** Loopback URL for a runtime service bound to `bindHost`. */
export function localServiceUrl(bindHost: string | undefined, port: number): string {
  const host = connectHostForBindHost(bindHost);
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

