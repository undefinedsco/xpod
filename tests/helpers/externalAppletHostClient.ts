import { EVENTS, Session } from '@inrupt/solid-client-authn-browser';

// Test consumer host, not a production third-party app. The host owns Inrupt;
// the sample applet invokes only requireLogin. Refresh restoration is this
// fixture's explicit policy and does not establish an Xpod applet policy.
const session = new Session();
const config = JSON.parse(document.querySelector('#host-config')!.textContent!) as {
  issuer: string;
  bindings: { webId: string; podUrl: string }[];
};
const returnPathKey = 'external-applet.return-path';
const signedOutKey = 'external-applet.signed-out';
const output = document.querySelector('output')!;
const loginButton = document.querySelector<HTMLButtonElement>('#login')!;
loginButton.disabled = true;
const host = {
  solid: {
    requireLogin: async () => {
      loginButton.disabled = true;
      sessionStorage.removeItem(signedOutKey);
      sessionStorage.setItem(returnPathKey, `${location.pathname}${location.search}${location.hash}`);
      await session.login({
        oidcIssuer: config.issuer,
        redirectUrl: new URL('/auth/callback', location.origin).href,
        clientName: 'External applet host acceptance',
        handleRedirect: (url) => {
          const authorization = new URL(url);
          // An explicit login action may switch accounts despite the IdP cookie.
          authorization.searchParams.set('prompt', 'login');
          location.assign(authorization.href);
        },
      });
    },
  },
};

async function start(): Promise<void> {
  // Inrupt reports denied authorization through ERROR and may clean the URL
  // before handleIncomingRedirect resolves; it need not reject its promise.
  session.events.on(EVENTS.ERROR, fail);
  document.querySelector('#login')!.addEventListener('click', () => { void host.solid.requireLogin().catch(fail); });
  document.querySelector('#logout')!.addEventListener('click', () => {
    void (async () => {
      const binding = config.bindings.find((candidate) => candidate.webId === session.info.webId);
      if (!binding) throw new Error('No authenticated fixture binding to sign out');
      const privateUrl = new URL('external-host-private.txt', binding.podUrl).href;
      const created = await session.fetch(privateUrl, {
        method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'private fixture session evidence',
      });
      if (!created.ok) throw new Error(`Private fixture write failed: ${created.status}`);
      await session.logout();
      sessionStorage.setItem(signedOutKey, 'true');
      clearIdentity();
      const signedOutRead = await session.fetch(privateUrl);
      output.dataset.testid = 'external-applet-anonymous';
      output.dataset.privateReadStatus = String(signedOutRead.status);
      output.textContent = 'Host WebID session signed out';
      loginButton.disabled = false;
    })().catch(fail);
  });
  if (location.pathname.startsWith('/applet/')) {
    sessionStorage.setItem(returnPathKey, `${location.pathname}${location.search}${location.hash}`);
  }
  await session.handleIncomingRedirect({
    restorePreviousSession: location.pathname !== '/auth/callback' && !sessionStorage.getItem(signedOutKey),
  });
  if (!session.info.isLoggedIn || !session.info.webId) {
    loginButton.disabled = false;
    return;
  }
  const returnPath = sessionStorage.getItem(returnPathKey);
  if (returnPath?.startsWith('/applet/')) history.replaceState(null, '', returnPath);
  sessionStorage.removeItem(returnPathKey);
  // This fixture's known account bindings are selected by the SDK-verified
  // WebID. Never carry Alice's Pod into Bob's authenticated host.
  const binding = config.bindings.find((candidate) => candidate.webId === session.info.webId);
  if (!binding) throw new Error('No fixture binding for the authenticated WebID');
  const response = await session.fetch(binding.podUrl, { headers: { Accept: 'text/turtle' } });
  if (!response.ok) throw new Error(`Pod read failed: ${response.status}`);
  await response.text();
  output.dataset.testid = 'external-applet-ready';
  output.dataset.webid = session.info.webId;
  output.dataset.podUrl = binding.podUrl;
  output.dataset.podStatus = String(response.status);
  output.textContent = 'External applet ready';
}

function clearIdentity(): void {
  delete output.dataset.webid;
  delete output.dataset.podUrl;
  delete output.dataset.podStatus;
}

function fail(_error: unknown): void {
  loginButton.disabled = false;
  clearIdentity();
  output.dataset.testid = 'external-applet-error';
  output.textContent = 'Host WebID authentication did not complete';
}

void start().catch(fail);
