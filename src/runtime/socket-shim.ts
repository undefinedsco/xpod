import { acquireSocketFetchShim, releaseSocketFetchShim } from './socket-fetch';
import { acquireSocketHttpShim, releaseSocketHttpShim } from './socket-http';
import { registerSocketOrigin } from './socket-origin-registry';

export function registerSocketOriginShims(origin: string, socketPath: string): () => Promise<void> {
  const unregisterOrigin = registerSocketOrigin(origin, socketPath);
  acquireSocketFetchShim();
  acquireSocketHttpShim();

  let cleanedUp = false;
  return async(): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    unregisterOrigin();
    releaseSocketFetchShim();
    releaseSocketHttpShim();
  };
}
