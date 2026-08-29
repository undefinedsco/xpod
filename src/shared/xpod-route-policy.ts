/** Application routes that may be restored after the one Xpod login transaction. */
export const XPOD_RETURN_PATH_PREFIXES = [
  '/dashboard',
  '/status',
  '/network',
  '/settings',
  '/ai-config',
  '/ai-connections',
] as const;

export const XPOD_PRODUCT_ALIASES = {} as const;

export type XpodProductAlias = keyof typeof XPOD_PRODUCT_ALIASES;

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
    || !XPOD_RETURN_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
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
