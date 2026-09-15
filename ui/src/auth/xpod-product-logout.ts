import type { AuthContextType } from '../context/AuthContextValue';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

type LogoutStep = 'solid' | 'account';
export type XpodProductLogoutState =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly step: LogoutStep }
  | { readonly status: 'error'; readonly step: LogoutStep };

interface LogoutOperation {
  account: Pick<AuthContextType, 'logout' | 'isAnonymous'>;
  runtime?: Pick<XpodSolidRuntimeValue, 'logout'> | null;
  solidCleared: boolean;
  onComplete?: () => void;
}

let automaticLoginBlocked = false;
let logoutState: XpodProductLogoutState = { status: 'idle' };
let operation: LogoutOperation | undefined;
let inFlight: Promise<void> | undefined;
const logoutListeners = new Set<() => void>();

export const isXpodAutomaticLoginBlocked = () => automaticLoginBlocked;
export const getXpodProductLogoutState = () => logoutState;
export function subscribeXpodProductLogout(listener: () => void): () => void {
  logoutListeners.add(listener);
  return () => { logoutListeners.delete(listener); };
}

function publish(state: XpodProductLogoutState): void {
  logoutState = state;
  logoutListeners.forEach((listener) => listener());
}

/** Progress belongs to the product operation, even after its initiating card unmounts. */
export function logoutXpodProduct(
  account: Pick<AuthContextType, 'logout' | 'isAnonymous'>,
  runtime?: Pick<XpodSolidRuntimeValue, 'logout'> | null,
  options: { onComplete?: () => void } = {},
): Promise<void> {
  if (inFlight) return inFlight;
  automaticLoginBlocked = true;
  operation = { account, runtime, solidCleared: false, onComplete: options.onComplete };
  return retryXpodProductLogout();
}

/** Retry only unfinished cleanup; never erase the successful Solid step. */
export function retryXpodProductLogout(): Promise<void> {
  if (inFlight) return inFlight;
  if (!operation) return Promise.resolve();
  const current = operation;
  const attempt = async () => {
    let step: LogoutStep = current.solidCleared ? 'account' : 'solid';
    publish({ status: 'running', step });
    try {
      if (!current.solidCleared) {
        await current.runtime?.logout();
        current.solidCleared = true;
      }
      step = 'account';
      publish({ status: 'running', step });
      await current.account.logout();
      if (current.account.isAnonymous && !current.account.isAnonymous()) {
        throw new Error('Account sign-out did not complete');
      }
    } catch (error) {
      publish({ status: 'error', step });
      throw error;
    }
    operation = undefined;
    publish({ status: 'idle' });
    current.onComplete?.();
  };
  inFlight = attempt().finally(() => { inFlight = undefined; });
  return inFlight;
}
