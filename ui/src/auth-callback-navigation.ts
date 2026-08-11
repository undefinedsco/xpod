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

function isProductPath(pathname: string): boolean {
  return pathname.startsWith('/settings') || pathname.startsWith('/dashboard');
}
