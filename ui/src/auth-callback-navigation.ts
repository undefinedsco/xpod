import { productSurfaceRoots } from './routes/canonical-routes';

export interface CallbackNavigationLocation {
  readonly origin: string;
  replace(url: string): void;
}

export interface CallbackNavigationHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface CallbackNavigationOptions {
  location: CallbackNavigationLocation;
  history: CallbackNavigationHistory;
}

export type CallbackProductApp = 'dashboard' | 'settings';

export interface CallbackProductDestination {
  app: CallbackProductApp;
  pathname: string;
  target: string;
}

/**
 * Keep the first product render in the callback document so its authenticated
 * Inrupt Session (and fetch closure) survives the redirect handoff.
 */
export function createCallbackNavigation({
  location,
  history,
}: CallbackNavigationOptions): CallbackNavigationLocation {
  return {
    origin: location.origin,
    replace(url: string) {
      const destination = new URL(url, location.origin);
      if (destination.origin === location.origin && isProductPath(destination.pathname)) {
        history.replaceState(
          {},
          '',
          `${destination.pathname}${destination.search}${destination.hash}`,
        );
        return;
      }
      location.replace(destination.href);
    },
  };
}

export function callbackProductAppForDestination(
  destination: string,
  currentOrigin: string,
): CallbackProductApp | undefined {
  return resolveCallbackProductDestination(destination, currentOrigin)?.app;
}

export function resolveCallbackProductDestination(
  destination: string,
  currentOrigin: string,
): CallbackProductDestination | undefined {
  try {
    const url = new URL(destination, currentOrigin);
    if (url.origin !== currentOrigin) return undefined;
    const app = productAppForPathname(url.pathname);
    if (!app) return undefined;
    return {
      app,
      pathname: url.pathname,
      target: `${url.pathname}${url.search}${url.hash}`,
    };
  } catch {
    return undefined;
  }
}

function isProductPath(pathname: string): boolean {
  return productAppForPathname(pathname) !== undefined;
}

function productAppForPathname(pathname: string): CallbackProductApp | undefined {
  return productSurfaceRoots.find(({ basename }) => (
    pathname === basename || pathname.startsWith(`${basename}/`)
  ))?.app;
}
