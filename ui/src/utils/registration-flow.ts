import { buildPodCreatePayload, clearStoredProvisionCode } from './pod';

export interface RegistrationFlowResult {
  redirectedToConsent: boolean;
}

export interface RegistrationAccountBootstrapOptions {
  accountCreateUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  idpIndex: string;
}

export interface RegistrationFlowOptions {
  fetchImpl?: typeof fetch;
  idpIndex: string;
  username: string;
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  const json = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
  return json?.message || json?.error;
}

interface AccountControlsResponse {
  controls?: {
    account?: {
      pod?: string;
      webId?: string;
    };
  };
}

interface AccountPodResponse {
  pods?: Record<string, string>;
}

interface AccountWebIdResponse {
  webIdLinks?: Record<string, string>;
}

interface AccountStatusEndpoints {
  pod?: string;
  webId?: string;
}

function isUsernameConflict(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /There already is a resource at/i.test(message) ||
    /Username already taken/i.test(message);
}

function accountTokenHeaders(accountToken: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `CSS-Account-Token ${accountToken}`,
  };
}

export async function bootstrapAccountPasswordLogin(
  options: RegistrationAccountBootstrapOptions,
): Promise<{ loginUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let res = await fetchImpl(options.accountCreateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({})) as any).message || 'Failed to create account');
  }

  const accountCreateResult = await res.json().catch(() => ({})) as { authorization?: string };
  const accountToken = typeof accountCreateResult.authorization === 'string' ? accountCreateResult.authorization : '';
  if (!accountToken) {
    throw new Error('Account token not returned');
  }

  res = await fetchImpl(options.idpIndex, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({})) as any).message || 'Failed to load account controls');
  }

  const controls = await res.json().catch(() => ({})) as any;
  const addPasswordUrl = controls.controls?.password?.create;
  const loginUrl = controls.controls?.password?.login;
  if (!addPasswordUrl) {
    throw new Error('Password endpoint not found');
  }
  if (!loginUrl) {
    throw new Error('Login endpoint not found');
  }

  res = await fetchImpl(addPasswordUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(accountToken),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!res.ok) {
    throw new Error((await res.json().catch(() => ({})) as any).message || 'Failed to set password');
  }

  return { loginUrl };
}

export async function defaultWaitForWebIdReady(
  fetchImpl: typeof fetch,
  idpIndex: string,
  endpoints?: AccountStatusEndpoints,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let accountPodUrl = endpoints?.pod;
  let accountWebIdUrl = endpoints?.webId;

  while (Date.now() < deadline) {
    try {
      if (!accountPodUrl && !accountWebIdUrl) {
        const controlsRes = await fetchImpl(idpIndex, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        } as RequestInit);
        if (controlsRes.ok) {
          const controlsData = await controlsRes.json().catch(() => ({})) as AccountControlsResponse;
          accountPodUrl = controlsData.controls?.account?.pod;
          accountWebIdUrl = controlsData.controls?.account?.webId;
        }
      }

      if (accountWebIdUrl) {
        const webIdRes = await fetchImpl(accountWebIdUrl, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        } as RequestInit);
        if (webIdRes.ok) {
          const data = await webIdRes.json().catch(() => ({})) as AccountWebIdResponse;
          if (Object.keys(data.webIdLinks ?? {}).length > 0) {
            return true;
          }
        }
      }

      if (accountPodUrl) {
        const podRes = await fetchImpl(accountPodUrl, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        } as RequestInit);
        if (podRes.ok) {
          const data = await podRes.json().catch(() => ({})) as AccountPodResponse;
          if (Object.keys(data.pods ?? {}).length > 0) {
            return true;
          }
        }
      }
    } catch {
      // ignore transient fetch failures while the account state settles
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

export async function completeRegistrationProvisioning(
  options: RegistrationFlowOptions,
): Promise<RegistrationFlowResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { idpIndex, username } = options;

  let res = await fetchImpl(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' } as RequestInit);
  const accountData = await res.json().catch(() => ({})) as any;
  const createPodUrl = accountData.controls?.account?.pod;
  if (!createPodUrl) {
    throw new Error('Pod creation endpoint not found');
  }

  res = await fetchImpl(createPodUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(buildPodCreatePayload(username)),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (isUsernameConflict(message)) {
      throw new Error('Username is already taken. Your account was created; sign in and choose another Pod name.');
    }
    throw new Error(message || 'Failed to create pod');
  }
  const podCreateResult = await res.json().catch(() => ({})) as any;
  clearStoredProvisionCode();
  void podCreateResult;

  await defaultWaitForWebIdReady(fetchImpl, idpIndex, accountData.controls?.account);

  const consentCheck = await fetchImpl('/.account/oidc/consent/', {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  } as RequestInit);
  if (consentCheck.ok) {
    const consentData = await consentCheck.json().catch(() => ({})) as any;
    if (consentData.client) {
      return { redirectedToConsent: true };
    }
  }

  return { redirectedToConsent: false };
}
