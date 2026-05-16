const CSS_ACCOUNT_COOKIE_NAME = 'css-account';
const CSS_ACCOUNT_TOKEN_STORAGE_KEY = 'xpod.cssAccountToken';
const CSS_ACCOUNT_AUTH_SCHEME = 'CSS-Account-Token';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readCssAccountCookie(): string | undefined {
  if (!isBrowser()) {
    return undefined;
  }

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (rawName === CSS_ACCOUNT_COOKIE_NAME) {
      const value = rawValue.join('=');
      try {
        return value ? decodeURIComponent(value) : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function writeCssAccountCookie(token: string): void {
  if (!isBrowser()) {
    return;
  }

  document.cookie = `${CSS_ACCOUNT_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
}

function clearCssAccountCookie(): void {
  if (!isBrowser()) {
    return;
  }

  document.cookie = `${CSS_ACCOUNT_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`;
}

function getStoredToken(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const token = window.sessionStorage.getItem(CSS_ACCOUNT_TOKEN_STORAGE_KEY);
    return token || undefined;
  } catch {
    return undefined;
  }
}

function setStoredToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(CSS_ACCOUNT_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable in restricted browser contexts; the cookie remains the primary session.
  }
}

function clearStoredToken(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.removeItem(CSS_ACCOUNT_TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures during logout.
  }
}

export function storeAccountSessionToken(token: string | undefined): void {
  if (!token) {
    return;
  }

  setStoredToken(token);
  writeCssAccountCookie(token);
}

export function clearAccountSessionToken(): void {
  clearStoredToken();
  clearCssAccountCookie();
}

export function getAccountSessionToken(): string | undefined {
  const cookieToken = readCssAccountCookie();
  if (cookieToken) {
    return cookieToken;
  }

  const storedToken = getStoredToken();
  if (storedToken) {
    writeCssAccountCookie(storedToken);
    return storedToken;
  }

  return undefined;
}

export function accountTokenHeaders(
  accountToken: string | undefined,
  baseHeaders: Record<string, string> = { Accept: 'application/json' },
): Record<string, string> {
  const headers = { ...baseHeaders };
  if (accountToken && !hasHeader(headers, 'Authorization')) {
    headers.Authorization = `${CSS_ACCOUNT_AUTH_SCHEME} ${accountToken}`;
  }
  return headers;
}

export function storedAccountTokenHeaders(
  baseHeaders: Record<string, string> = { Accept: 'application/json' },
): Record<string, string> {
  return accountTokenHeaders(getAccountSessionToken(), baseHeaders);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowerName);
}
