import { consumeReturnTo } from '../utils/returnTo';

// A user preference for this host, not a login lock or a Session record.
// Persist through a desktop restart; explicit Continue opts back into login.
const CANCELLED_LOGIN_KEY = 'xpod.auth.login-cancelled';

export function setXpodLoginCancelled(cancelled: boolean): void {
  try {
    if (cancelled) window.localStorage.setItem(CANCELLED_LOGIN_KEY, '1');
    else window.localStorage.removeItem(CANCELLED_LOGIN_KEY);
  } catch { /* The current mounted boundary still retains the user's choice. */ }
}

function consumeXpodLoginIntent(intent: 'cancelled' | 'switch'): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get('xpod-login') !== intent) return false;
  setXpodLoginCancelled(true);
  consumeReturnTo();
  url.searchParams.delete('xpod-login');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}

export function readXpodAccountSwitch(): boolean {
  return new URL(window.location.href).searchParams.get('xpod-login') === 'switch';
}

/** A one-shot navigation request; it carries no identity or credential. */
export function consumeXpodAccountSwitch(): boolean {
  return consumeXpodLoginIntent('switch');
}

/** Consume the native recovery intent before any silent restore effect runs. */
export function readXpodLoginCancelled(): boolean {
  if (consumeXpodLoginIntent('cancelled')) return true;
  try { return window.localStorage.getItem(CANCELLED_LOGIN_KEY) === '1'; }
  catch { return false; }
}
