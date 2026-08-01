const RETURN_TO_KEY = 'xpod:returnTo';

export function persistReturnTo(url: string): void {
  try {
    if (url) sessionStorage.setItem(RETURN_TO_KEY, url);
  } catch {
    return;
  }
}

export function consumeReturnTo(): string | null {
  try {
    const url = sessionStorage.getItem(RETURN_TO_KEY);
    if (url) sessionStorage.removeItem(RETURN_TO_KEY);
    return url;
  } catch {
    return null;
  }
}

export function getReturnToFromLocation(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get('returnTo');
    if (!value) return null;
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return null;
    return value;
  } catch {
    return null;
  }
}
