import type { StorageBinding, WebIdLoginRouteDescriptor, WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import {
  createXpodLoginRoute,
  createXpodLoginRoutes,
  normalizeXpodReturnTo,
} from './xpod-login-route';
import {
  createOpaqueTransactionId,
  createXpodLoginTransactionStore,
  XpodLoginTransactionError,
  type XpodLoginTransactionStore,
} from './xpod-login-transaction';

export interface XpodLoginControllerOptions {
  runtime: Pick<XpodSolidRuntimeValue, 'login'>;
  transactionStore?: XpodLoginTransactionStore;
  location?: Location | URL | string;
  routes?: readonly WebIdLoginRouteDescriptor[];
}

export interface XpodLoginControllerApi {
  readonly routes: readonly [WebIdLoginRouteDescriptor];
  startLogin(returnTo?: string, selectedStorage?: StorageBinding): Promise<WebIdLoginTransaction>;
  retryLogin(returnTo?: string, selectedStorage?: StorageBinding): Promise<WebIdLoginTransaction>;
  cancelLogin(): void;
  readPending(): WebIdLoginTransaction | undefined;
  callbackUrl(transactionId: string): string;
}

export function createXpodLoginController(options: XpodLoginControllerOptions): XpodLoginControllerApi {
  const location = options.location ?? (typeof window === 'undefined' ? 'http://localhost/' : window.location);
  const route = createXpodLoginRoute(location);
  // Xpod policy deliberately ignores host-supplied route lists: this host has
  // one fixed route and never renders a chooser or custom issuer.
  const routes = [route] as const;
  const origin = toOrigin(location);
  const transactionStore = options.transactionStore ?? createXpodLoginTransactionStore({ origin });

  const resolveReturnTo = (value?: string): string | undefined => {
    if (value !== undefined) return normalizeXpodReturnTo(value);
    const locationUrl = new URL(toHref(location));
    const currentPath = `${locationUrl.pathname}${locationUrl.search}`;
    try {
      return normalizeXpodReturnTo(currentPath);
    } catch {
      return undefined;
    }
  };

  // A completed login attempt redirects the whole tab away, so a pending
  // transaction encountered while no login is in flight here is residue from
  // an interrupted redirect (or a previous page load within the store TTL).
  // Cancelling it and retrying once keeps "continue" from dead-ending; a
  // genuinely concurrent start from this controller still rejects.
  let loginInFlight = false;
  const beginRecoverable = (transaction: WebIdLoginTransaction): WebIdLoginTransaction => {
    try {
      return transactionStore.begin(transaction);
    } catch (error) {
      if (loginInFlight
        || !(error instanceof XpodLoginTransactionError)
        || error.code !== 'already_active') {
        throw error;
      }
      try {
        const stale = transactionStore.readSinglePending();
        if (stale) transactionStore.cancel(stale.id);
      } catch {
        // The store already clears expired/malformed records while reading.
      }
      return transactionStore.begin(transaction);
    }
  };

  const startLogin = async (
    returnTo?: string,
    selectedStorage?: StorageBinding,
  ): Promise<WebIdLoginTransaction> => {
    const resolvedReturnTo = resolveReturnTo(returnTo);
    const transaction: WebIdLoginTransaction = {
      id: createOpaqueTransactionId(),
      route: routes[0],
      authorizationSurface: 'redirect',
      discovery: 'strict',
      ...(resolvedReturnTo === undefined ? {} : { returnTo: resolvedReturnTo }),
      ...(selectedStorage === undefined ? {} : { selectedStorage }),
    };
    const pending = beginRecoverable(transaction);
    loginInFlight = true;
    try {
      await options.runtime.login(pending);
    } catch (error) {
      try {
        transactionStore.cancel(pending.id);
      } catch {
        // Preserve the original login error when cleanup races with a callback.
      }
      throw error;
    } finally {
      loginInFlight = false;
    }
    return pending;
  };

  return {
    routes,
    startLogin,
    retryLogin: startLogin,
    cancelLogin() {
      const pending = transactionStore.readSinglePending();
      if (pending) transactionStore.cancel(pending.id);
    },
    readPending: () => transactionStore.readSinglePending(),
    callbackUrl(_transactionId) {
      // Inrupt persists and later reuses this URL for prompt=none restoration.
      // Keep it stable; the one active Xpod transaction remains tab-scoped in
      // sessionStorage and is correlated after Inrupt validates state/PKCE.
      return `${origin}/auth/callback`;
    },
  };
}

export { createXpodLoginRoutes };
export const getXpodLoginRoute = createXpodLoginRoute;

function toOrigin(locationLike: Location | URL | string): string {
  return new URL(toHref(locationLike)).origin;
}

function toHref(locationLike: Location | URL | string): string {
  if (typeof locationLike === 'string') return locationLike;
  return locationLike.href;
}
