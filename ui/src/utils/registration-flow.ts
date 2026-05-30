import { buildPodCreatePayload, getStoredProvisionCode } from './pod';
import { accountTokenHeaders } from './account-session';
import { lookupProvisionScopedWebIds, parseProvisionScope } from './storage-scope';

export interface RegistrationFlowResult {
  createdPod: boolean;
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
  accountToken: string;
  fetchImpl?: typeof fetch;
  idpIndex: string;
  provisionCode?: string;
  username: string;
}

export interface PasswordLoginOptions {
  duplicateEmailRecovery?: boolean;
  email: string;
  fetchImpl?: typeof fetch;
  loginUrl: string;
  password: string;
}

export class RegistrationError extends Error {
  public readonly code: 'EMAIL_ALREADY_REGISTERED' | 'USERNAME_ALREADY_TAKEN' | 'UNKNOWN';

  public constructor(
    message: string,
    code: 'EMAIL_ALREADY_REGISTERED' | 'USERNAME_ALREADY_TAKEN' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
  }
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

function extractConflictResourceUrl(message: string): string | undefined {
  return message.match(/There already is a resource at\s+(\S+)/iu)?.[1];
}

function isUsernameConflict(message: string | undefined, username: string): boolean {
  if (!message) {
    return false;
  }

  const resourceUrl = extractConflictResourceUrl(message);
  if (resourceUrl) {
    return podUrlMatchesUsername(resourceUrl, username);
  }

  const podName = message.match(/Pod name "([^"]+)" is already taken/iu)?.[1];
  if (podName) {
    return podName === username;
  }

  return /Username already taken/i.test(message);
}

function isDuplicateEmail(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /already is a login for this e-mail address/i.test(message) ||
    /email(?: address)? is already/i.test(message) ||
    /already registered/i.test(message);
}

function podUrlMatchesUsername(podUrl: string, username: string): boolean {
  try {
    const url = new URL(podUrl, 'http://xpod.local');
    const firstSegment = url.pathname.split('/').filter(Boolean)[0];
    return firstSegment === username;
  } catch {
    return false;
  }
}

async function hasExistingPod(
  fetchImpl: typeof fetch,
  accountPodUrl: string,
  accountWebIdUrl: string | undefined,
  username: string,
  accountToken: string,
  provisionCode?: string,
): Promise<boolean> {
  if (provisionCode) {
    return hasExistingProvisionScopedPod(fetchImpl, accountWebIdUrl, username, accountToken, provisionCode);
  }

  const res = await fetchImpl(accountPodUrl, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    return false;
  }

  const data = await res.json().catch(() => ({})) as AccountPodResponse;
  return Object.keys(data.pods ?? {}).some((podUrl) => podUrlMatchesUsername(podUrl, username));
}

async function hasExistingProvisionScopedPod(
  fetchImpl: typeof fetch,
  accountWebIdUrl: string | undefined,
  username: string,
  accountToken: string,
  provisionCode: string,
): Promise<boolean> {
  const scope = parseProvisionScope(provisionCode);
  if (!scope || !accountWebIdUrl) {
    return false;
  }

  const res = await fetchImpl(accountWebIdUrl, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    return false;
  }

  const data = await res.json().catch(() => ({})) as AccountWebIdResponse;
  const webIds = Object.keys(data.webIdLinks ?? {});
  const entries = await lookupProvisionScopedWebIds(fetchImpl, webIds, scope);
  return entries.some((entry) => podUrlMatchesUsername(entry.storageUrl, username));
}

export async function bootstrapAccountPasswordLogin(
  options: RegistrationAccountBootstrapOptions,
): Promise<{ accountToken: string; loginUrl: string }> {
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
    const message = await readErrorMessage(res);
    if (isDuplicateEmail(message)) {
      throw new RegistrationError(
        'This email is already registered. Sign in instead, or reset the password.',
        'EMAIL_ALREADY_REGISTERED',
      );
    }
    throw new Error(message || 'Failed to set password');
  }

  return { accountToken, loginUrl };
}

export async function loginAccountPassword(
  options: PasswordLoginOptions,
): Promise<{ accountToken: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(options.loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (options.duplicateEmailRecovery) {
      throw new RegistrationError(
        'This email is already registered, but the password did not match. Sign in or reset the password.',
        'EMAIL_ALREADY_REGISTERED',
      );
    }
    throw new Error(message || 'Auto-login failed');
  }

  const data = await res.json().catch(() => ({})) as { authorization?: string };
  const accountToken = typeof data.authorization === 'string' ? data.authorization : '';
  if (!accountToken) {
    throw new Error('Account token not returned after login');
  }

  return { accountToken };
}

export async function defaultWaitForWebIdReady(
  fetchImpl: typeof fetch,
  idpIndex: string,
  endpoints?: AccountStatusEndpoints,
  accountToken?: string,
  timeoutMs = 15_000,
  provisionCode?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let accountPodUrl = endpoints?.pod;
  let accountWebIdUrl = endpoints?.webId;
  const provisionScope = parseProvisionScope(provisionCode);

  while (Date.now() < deadline) {
    try {
      if (!accountPodUrl && !accountWebIdUrl) {
        const controlsRes = await fetchImpl(idpIndex, {
          headers: accountTokenHeaders(accountToken),
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
          headers: accountTokenHeaders(accountToken),
          credentials: 'include',
        } as RequestInit);
        if (webIdRes.ok) {
          const data = await webIdRes.json().catch(() => ({})) as AccountWebIdResponse;
          const webIds = Object.keys(data.webIdLinks ?? {});
          if (provisionScope) {
            const entries = await lookupProvisionScopedWebIds(fetchImpl, webIds, provisionScope);
            if (entries.length > 0) {
              return true;
            }
          } else if (!provisionCode && webIds.length > 0) {
            return true;
          }
        }
      }

      if (!provisionCode && accountPodUrl) {
        const podRes = await fetchImpl(accountPodUrl, {
          headers: accountTokenHeaders(accountToken),
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
  const { accountToken, idpIndex, username } = options;
  const provisionCode = options.provisionCode ?? getStoredProvisionCode();

  let res = await fetchImpl(idpIndex, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  const accountData = await res.json().catch(() => ({})) as any;
  const createPodUrl = accountData.controls?.account?.pod;
  if (!createPodUrl) {
    throw new Error('Pod creation endpoint not found. The account API did not expose controls.account.pod.');
  }

  if (await hasExistingPod(fetchImpl, createPodUrl, accountData.controls?.account?.webId, username, accountToken, provisionCode)) {
    await defaultWaitForWebIdReady(fetchImpl, idpIndex, accountData.controls?.account, accountToken, 15_000, provisionCode);
    return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
  }

  res = await fetchImpl(createPodUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(accountToken),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(buildPodCreatePayload(username, provisionCode)),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (isUsernameConflict(message, username)) {
      throw new RegistrationError(
        'Username is already taken. Your account was created; sign in and choose another Pod name.',
        'USERNAME_ALREADY_TAKEN',
      );
    }
    throw new Error(message || 'Failed to create pod');
  }
  const podCreateResult = await res.json().catch(() => ({})) as any;
  void podCreateResult;

  await defaultWaitForWebIdReady(fetchImpl, idpIndex, accountData.controls?.account, accountToken, 15_000, provisionCode);

  return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
}

async function hasPendingConsent(fetchImpl: typeof fetch, accountToken: string): Promise<boolean> {
  const consentCheck = await fetchImpl('/.account/oidc/consent/', {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (consentCheck.ok) {
    const consentData = await consentCheck.json().catch(() => ({})) as any;
    if (consentData.client) {
      return true;
    }
  }

  return false;
}
