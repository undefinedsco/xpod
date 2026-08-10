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

export class XpodLoginController implements XpodLoginControllerApi {
  private readonly delegate: XpodLoginControllerApi;

  constructor(options: XpodLoginControllerOptions) {
    this.delegate = createXpodLoginController(options);
  }

  get routes() {
    return this.delegate.routes;
  }

  startLogin(returnTo?: string, selectedStorage?: StorageBinding) {
    return this.delegate.startLogin(returnTo, selectedStorage);
  }

  retryLogin(returnTo?: string, selectedStorage?: StorageBinding) {
    return this.delegate.retryLogin(returnTo, selectedStorage);
  }

  cancelLogin() {
    this.delegate.cancelLogin();
  }

  readPending() {
    return this.delegate.readPending();
  }

  callbackUrl(transactionId: string) {
    return this.delegate.callbackUrl(transactionId);
  }
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
    const pending = transactionStore.begin(transaction);
    try {
      await options.runtime.login(pending);
    } catch (error) {
      try {
        transactionStore.cancel(pending.id);
      } catch {
        // Preserve the original login error when cleanup races with a callback.
      }
      throw error;
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
    callbackUrl(transactionId) {
      return `${origin}/auth/callback?transaction=${encodeURIComponent(transactionId)}`;
    },
  };
}

export const createXpodLoginPath = createXpodLoginController;
export { createXpodLoginRoutes };
export const getXpodLoginRoute = createXpodLoginRoute;

function toOrigin(locationLike: Location | URL | string): string {
  return new URL(toHref(locationLike)).origin;
}

function toHref(locationLike: Location | URL | string): string {
  if (typeof locationLike === 'string') return locationLike;
  return locationLike.href;
}
