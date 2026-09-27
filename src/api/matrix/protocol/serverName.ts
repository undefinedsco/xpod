/**
 * Matrix server names: `host[:port]`, and the WebID they are derived from.
 *
 * A server name is the identity a homeserver signs as. In this deployment it is
 * *derived*, never stored: a participant's server name is the host of their WebID, so
 * the same rule serves event attribution, key lookup and request routing. Keeping the
 * grammar and the derivation in one module means "which server does this WebID belong
 * to" has exactly one answer.
 *
 * Server names arrive inside peer-supplied data (an event's `sender`, a request's
 * `origin`) and get resolved to endpoints, so anything that could point somewhere else
 * (`/`, `@`, whitespace, credentials, fragments) is refused before use.
 */
export function isMatrixServerName(value: string): boolean {
  const match = /^(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::(?<port>\d{1,5}))?$/u.exec(value);
  if (!match?.groups) return false;
  const port = match.groups.port;
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

/** Split `host[:port]`; the host is returned without brackets, the port as a number. */
export function splitServerName(serverName: string): { host: string; port?: number } {
  const match = /^(?<host>\[[0-9A-Fa-f:.]+\]|[^:]+)(?::(?<port>\d+))?$/u.exec(serverName);
  const rawHost = match?.groups?.host ?? serverName;
  const port = match?.groups?.port;
  return { host: stripBrackets(rawHost), ...(port === undefined ? {} : { port: Number(port) }) };
}

/**
 * The server name a WebID belongs to: its host, when that host is a usable server name.
 * `undefined` means this WebID cannot be anybody's server, so callers fall back rather
 * than invent a name that could never be signed for.
 */
export function webIdServerName(webId: string): string | undefined {
  let host: string;
  try {
    host = new URL(webId).host;
  } catch {
    return undefined;
  }
  return host && isMatrixServerName(host) ? host : undefined;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
