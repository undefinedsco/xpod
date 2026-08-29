/**
 * Host-owned logout coordination for the two authentication domains Xpod
 * composes: the CSS Account and the browser Solid/WebID session.
 *
 * The coordinator deliberately keeps only public domain status. It does not
 * persist tokens, controls, session material, or exception messages.
 */

export type LogoutDomainState = 'pending' | 'complete' | 'error';

export type XpodLogoutState =
  | { status: 'idle' }
  | {
      status: 'running' | 'error';
      account: LogoutDomainState;
      webId: LogoutDomainState;
    }
  | {
      status: 'complete';
      account: 'complete';
      webId: 'complete';
    };

export interface XpodLogoutDomainPort {
  /** Perform the domain's idempotent logout operation. */
  logout: () => Promise<void>;
  /** Verify that the domain is anonymous after logout. */
  verifyAnonymous?: () => Promise<boolean> | boolean;
}

export interface XpodLogoutCoordinatorOptions {
  account: XpodLogoutDomainPort;
  webId: XpodLogoutDomainPort;
}

export interface XpodLogoutCoordinator {
  getState(): XpodLogoutState;
  subscribe(listener: (state: XpodLogoutState) => void): () => void;
  /** Start the transaction once. Repeated calls while running/completed are idempotent; after an error the call reruns the unfinished domains. */
  logout(): Promise<XpodLogoutState>;
  /** Retry only domains that did not complete. */
  retry(): Promise<XpodLogoutState>;
  /** Return a completed coordinator to the idle state before a new login. */
  reset(): void;
}

type Domain = 'account' | 'webId';

export function createXpodLogoutCoordinator(
  options: XpodLogoutCoordinatorOptions,
): XpodLogoutCoordinator {
  let state: XpodLogoutState = { status: 'idle' };
  let transaction: Promise<XpodLogoutState> | undefined;
  const listeners = new Set<(nextState: XpodLogoutState) => void>();

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  const setState = (nextState: XpodLogoutState) => {
    state = nextState;
    emit();
  };

  const setDomainState = (domain: Domain, domainState: LogoutDomainState) => {
    if (state.status === 'idle' || state.status === 'complete') return;
    setState({ ...state, [domain]: domainState } as XpodLogoutState);
  };

  const portFor = (domain: Domain) => options[domain];

  const runDomain = async (domain: Domain): Promise<void> => {
    const port = portFor(domain);
    try {
      await port.logout();
      const verified = port.verifyAnonymous ? await port.verifyAnonymous() : true;
      if (!verified) throw new Error('logout verification failed');
      setDomainState(domain, 'complete');
    } catch {
      // Keep the public state deterministic and intentionally omit raw errors.
      setDomainState(domain, 'error');
    }
  };

  const begin = (): Promise<XpodLogoutState> => {
    if (transaction) return transaction;
    if (state.status === 'complete') return Promise.resolve(state);

    const account = state.status === 'error' && state.account === 'complete' ? 'complete' : 'pending';
    const webId = state.status === 'error' && state.webId === 'complete' ? 'complete' : 'pending';
    setState({ status: 'running', account, webId });

    const domains = (['account', 'webId'] as const).filter((domain) => (
      state.status === 'running' && state[domain] !== 'complete'
    ));
    transaction = Promise.all(domains.map((domain) => runDomain(domain))).then(() => {
      const accountState = state.status === 'running' ? state.account : 'error';
      const webIdState = state.status === 'running' ? state.webId : 'error';
      const nextState: XpodLogoutState = accountState === 'complete' && webIdState === 'complete'
        ? { status: 'complete', account: 'complete', webId: 'complete' }
        : { status: 'error', account: accountState, webId: webIdState };
      setState(nextState);
      return nextState;
    }).finally(() => {
      transaction = undefined;
    });
    return transaction;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout() {
      // An errored transaction must not dead-end callers such as
      // switchAccount: rerun the domains that did not complete instead of
      // returning the stale error forever.
      return begin();
    },
    retry() {
      return begin();
    },
    reset() {
      if (transaction) return;
      if (state.status !== 'complete') return;
      setState({ status: 'idle' });
    },
  };
}
