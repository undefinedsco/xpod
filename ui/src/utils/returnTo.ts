const RETURN_TO_KEY = 'xpod:returnTo';

export function persistReturnTo(url: string): void {
  try {
    if (url) sessionStorage.setItem(RETURN_TO_KEY, url);
  } catch {}
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
    return value || null;
  } catch {
    return null;
  }
}
