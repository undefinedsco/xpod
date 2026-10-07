/** Application routes that may be restored after the one Xpod login transaction. */
export const XPOD_RETURN_PATH_PREFIXES = [
  '/dashboard',
  '/status',
  '/network',
  '/settings',
  '/ai-config',
  '/ai-connections',
  '/tasks',
  '/pod',
  '/device',
  '/inbox',
  '/notifications',
] as const;

export const XPOD_PRODUCT_ALIASES = {} as const;

export type XpodProductAlias = keyof typeof XPOD_PRODUCT_ALIASES;

const desktopPages = new Set([
  '/tasks', '/pod', '/pod/models', '/pod/search', '/pod/apps', '/pod/data',
  '/device', '/device/network', '/device/services', '/device/runtime', '/device/logs',
  '/inbox', '/notifications',
]);

/** New applet names must not reserve every resource inside a same-named Pod. */
export function isXpodProductPath(pathname: string): boolean {
  const path = pathname.replace(/\/$/u, '');
  if (desktopPages.has(path)) return true;
  return XPOD_RETURN_PATH_PREFIXES.slice(0, 6).some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Keep API aliases and the client callback on the same application-relative path policy.
 * Query strings are intentionally retained; fragments are not part of an HTTP request URL.
 */
export function normalizeXpodReturnPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('returnTo must be a non-empty application path');
  }

  const normalized = value.trim();
  const decoded = decodeForValidation(normalized);
  const pathname = decoded.split(/[?#]/, 1)[0];
  if (
    !normalized.startsWith('/')
    || normalized.startsWith('//')
    || normalized.includes('\\')
    || decoded.includes('\\')
    || /^[a-z][a-z\d+.-]*:/i.test(decoded)
    || decoded.startsWith('//')
    || pathname.split('/').some((segment) => segment === '..')
    || !isXpodProductPath(pathname)
  ) {
    throw new TypeError('returnTo must be a safe path within the application allow-list');
  }
  return normalized;
}

function decodeForValidation(value: string): string {
  let decoded = value;
  for (let index = 0; index < 4; index += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new TypeError('returnTo contains malformed percent encoding');
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

export function resolveXpodAliasTarget(alias: XpodProductAlias, requestUrl: string): string {
  const source = new URL(requestUrl, 'http://xpod.local');
  const target = XPOD_PRODUCT_ALIASES[alias];
  return `${target}${source.search}`;
}
