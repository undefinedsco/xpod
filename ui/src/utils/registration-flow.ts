import { xpodRegistrationCopy } from '../auth/xpod-account-copy';
import { buildPodCreatePayload, resolveCurrentProvisionTarget, resolveProvisionCodeForPodCreate } from './pod';
import { accountTokenHeaders } from './account-session';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  lookupProvisionScopedWebIds,
  prepareProvisionedPod,
  storageUrlBelongsToRoot,
} from './provision-scope';
import { isRecord, readResponseMessage } from './errors';

export interface RegistrationFlowResult {
  createdPod: boolean;
  redirectedToConsent: boolean;
}

export interface RegistrationAccountBootstrapOptions {
  accountCreateUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export interface RegistrationFlowOptions {
  accountIndexUrl: string;
  accountToken: string;
  fetchImpl?: typeof fetch;
  provisionCode?: string;
  username: string;
}

function resolveAccountControlUrl(value: string | undefined, accountIndexUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const accountIndex = new URL(accountIndexUrl, globalThis.location?.origin ?? 'http://localhost');
    const advertised = new URL(value, accountIndex);
    return advertised.origin === accountIndex.origin
      ? advertised.href
      : new URL(`${advertised.pathname}${advertised.search}${advertised.hash}`, accountIndex.origin).href;
  } catch {
    return undefined;
  }
}

export interface PasswordLoginOptions {
  duplicateEmailRecovery?: boolean;
  email: string;
  fetchImpl?: typeof fetch;
  loginUrl: string;
  password: string;
  remember?: boolean;
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

export class RegistrationProvisioningNotReadyError extends Error {
  public readonly code = 'POD_CREATED_BUT_NOT_READY';
  public readonly createdPod = true;

  public constructor(message = 'Pod 已创建，但尚未确认 WebID 与存储绑定可用。请稍后重试确认，不要重复创建。') {
    super(message);
    this.name = 'RegistrationProvisioningNotReadyError';
  }
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  const json = await response.json().catch(() => undefined) as { message?: string; error?: string } | undefined;
  return json?.message || json?.error;
}

async function readResponseRecord(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as unknown;
  return isRecord(value) ? value : {};
}

interface AccountControlsResponse {
  controls?: {
    password?: {
      create?: string;
      login?: string;
    };
    account?: {
      pod?: string;
      webId?: string;
      bindings?: string;
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
  bindings?: string;
  pod?: string;
  webId?: string;
}

interface AuthorizationResponse {
  authorization?: string;
}

interface ConsentCheckResponse {
  client?: unknown;
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

function storageUrlMatchesUsername(storageUrl: string, username: string): boolean {
  return podUrlMatchesUsername(storageUrl, username);
}

function webIdUrlMatchesUsername(webIdUrl: string, username: string): boolean {
  try {
    const webId = new URL(webIdUrl, globalThis.location?.origin ?? 'http://localhost');
    const segments = webId.pathname.split('/').filter(Boolean);
    return segments[0] === username;
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

async function readAccountPodResponse(response: Response): Promise<AccountPodResponse> {
  const value = await response.json().catch(() => undefined) as unknown;
  if (!isRecord(value) || !isStringRecord(value.pods)) {
    throw new Error('Account pod response is malformed');
  }

  return {
    pods: value.pods,
  };
}

async function readAccountWebIdResponse(response: Response): Promise<AccountWebIdResponse> {
  const value = await response.json().catch(() => undefined) as unknown;
  if (!isRecord(value) || !isStringRecord(value.webIdLinks)) {
    throw new Error('Account WebID response is malformed');
  }

  return {
    webIdLinks: value.webIdLinks,
  };
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
    throw new Error(await readErrorMessage(res) || `Account pod query failed (${res.status})`);
  }

  const data = await readAccountPodResponse(res);
  return Object.keys(data.pods ?? {}).some((podUrl) => podUrlMatchesUsername(podUrl, username));
}

async function hasExistingProvisionScopedPod(
  fetchImpl: typeof fetch,
  accountWebIdUrl: string | undefined,
  username: string,
  accountToken: string,
  provisionCode: string,
): Promise<boolean> {
  if (!accountWebIdUrl) {
    throw new Error('WebID listing endpoint not found. The account API did not expose controls.account.webId.');
  }

  const res = await fetchImpl(accountWebIdUrl, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res) || `Account WebID query failed (${res.status})`);
  }

  const data = await readAccountWebIdResponse(res);
  const webIds = Object.keys(data.webIdLinks ?? {}).filter((webId) =>
    webIdUrlMatchesUsername(webId, username));
  const entries = await lookupProvisionScopedWebIds(fetchImpl, webIds, provisionCode);
  return (entries ?? []).some((entry) =>
    webIdUrlMatchesUsername(entry.webId, username) &&
    podUrlMatchesUsername(entry.storageUrl, username));
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
    throw new Error(readResponseMessage(await readResponseRecord(res)) || 'Failed to create account');
  }

  const accountCreateResult = await res.json().catch(() => ({})) as AuthorizationResponse;
  const accountToken = typeof accountCreateResult.authorization === 'string' ? accountCreateResult.authorization : '';
  if (!accountToken) {
    throw new Error('Account token not returned');
  }

  const accountCreateUrl = new URL(
    options.accountCreateUrl,
    globalThis.location?.origin ?? 'http://localhost',
  );
  const accountIndexUrl = new URL('/.account/', accountCreateUrl).href;
  res = await fetchImpl(accountIndexUrl, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    throw new Error(readResponseMessage(await readResponseRecord(res)) || 'Failed to load account controls');
  }

  const controls = await res.json().catch(() => ({})) as AccountControlsResponse;
  const addPasswordUrl = resolveAccountControlUrl(controls.controls?.password?.create, accountIndexUrl);
  const loginUrl = resolveAccountControlUrl(controls.controls?.password?.login, accountIndexUrl);
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
        xpodRegistrationCopy.emailAlreadyRegistered,
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
    body: JSON.stringify({
      email: options.email,
      password: options.password,
      ...(options.remember === undefined ? {} : { remember: options.remember }),
    }),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (options.duplicateEmailRecovery) {
      throw new RegistrationError(
        xpodRegistrationCopy.emailAlreadyRegisteredPasswordMismatch,
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
  username?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let statusEndpoints: AccountStatusEndpoints = {
    bindings: endpoints?.bindings,
    pod: endpoints?.pod,
    webId: endpoints?.webId,
  };
  const provisionTarget = await resolveCurrentProvisionTarget(provisionCode);
  const effectiveProvisionCode = provisionCode ?? provisionTarget.activeProvisionCode;

  while (Date.now() < deadline) {
    try {
      if (!statusEndpoints.pod && !statusEndpoints.webId) {
        if (!accountToken) {
          throw new Error('Account token is required to load account controls');
        }
        statusEndpoints = await loadRegistrationAccountEndpoints(fetchImpl, idpIndex, accountToken);
      }

      if (!accountToken || !username) {
        throw new Error('Account token and username are required to check registration readiness');
      }

      if (await checkRegistrationReadinessOnce(
        fetchImpl,
        idpIndex,
        statusEndpoints,
        accountToken,
        effectiveProvisionCode,
        username,
        provisionTarget?.storageRoot,
      )) {
        return true;
      }
    } catch {
      // ignore transient fetch failures while the account state settles
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function hasDurableExactBinding(
  fetchImpl: typeof fetch,
  accountIndexUrl: string,
  endpoints: AccountStatusEndpoints,
  accountToken: string,
  username: string,
  storageRoot?: string,
): Promise<boolean> {
  if (!endpoints.bindings) {
    return false;
  }

  const accountIndex = new URL(accountIndexUrl, globalThis.location?.origin ?? 'http://localhost');
  const trustedAccountIndex = accountIndex.pathname.startsWith('/.account/')
    ? accountIndex.href
    : new URL('/.account/', accountIndex).href;
  const bindings = await fetchAccountStorageBindings({
    controls: { account: { bindings: endpoints.bindings } },
    fetchImpl,
    headers: accountTokenHeaders(accountToken),
    origin: accountIndex.origin,
    trustedAccountIndex,
  });
  return bindings.some((binding) =>
    webIdUrlMatchesUsername(binding.webId, username) &&
    storageUrlMatchesUsername(binding.storageUrl, username) &&
    (!storageRoot || storageUrlBelongsToRoot(binding.storageUrl, storageRoot)));
}

async function loadRegistrationAccountEndpoints(
  fetchImpl: typeof fetch,
  accountIndexUrl: string,
  accountToken: string,
): Promise<AccountStatusEndpoints> {
  const res = await fetchImpl(accountIndexUrl, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res) || `Failed to load account controls (${res.status})`);
  }

  const accountData = await res.json().catch(() => ({})) as AccountControlsResponse;
  return {
    bindings: resolveAccountControlUrl(accountData.controls?.account?.bindings, accountIndexUrl),
    pod: resolveAccountControlUrl(accountData.controls?.account?.pod, accountIndexUrl),
    webId: resolveAccountControlUrl(accountData.controls?.account?.webId, accountIndexUrl),
  };
}

async function checkRegistrationReadinessOnce(
  fetchImpl: typeof fetch,
  accountIndexUrl: string,
  endpoints: AccountStatusEndpoints,
  accountToken: string,
  provisionCode: string | undefined,
  username: string,
  storageRoot?: string,
): Promise<boolean> {
  if (await hasDurableExactBinding(fetchImpl, accountIndexUrl, endpoints, accountToken, username, storageRoot)) {
    return true;
  }

  if (storageRoot && !provisionCode) {
    return false;
  }

  if (endpoints.webId) {
    const webIdRes = await fetchImpl(endpoints.webId, {
      headers: accountTokenHeaders(accountToken),
      credentials: 'include',
    } as RequestInit);
    if (!webIdRes.ok) {
      throw new Error(await readErrorMessage(webIdRes) || `Account WebID query failed (${webIdRes.status})`);
    }

    const data = await readAccountWebIdResponse(webIdRes);
    const webIds = Object.keys(data.webIdLinks ?? {}).filter((webId) =>
      webIdUrlMatchesUsername(webId, username));
    if (provisionCode) {
      const entries = await lookupProvisionScopedWebIds(fetchImpl, webIds, provisionCode);
      return (entries ?? []).some((entry) =>
        webIdUrlMatchesUsername(entry.webId, username) &&
        podUrlMatchesUsername(entry.storageUrl, username) &&
        (!storageRoot || storageUrlBelongsToRoot(entry.storageUrl, storageRoot)));
    }
    if (webIds.length > 0) {
      return true;
    }
  }

  if (provisionCode) {
    throw new Error('WebID listing endpoint not found. The account API did not expose controls.account.webId.');
  }

  if (!endpoints.pod) {
    throw new Error('Pod listing endpoint not found. The account API did not expose controls.account.pod.');
  }

  const podRes = await fetchImpl(endpoints.pod, {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (!podRes.ok) {
    throw new Error(await readErrorMessage(podRes) || `Account pod query failed (${podRes.status})`);
  }

  const data = await readAccountPodResponse(podRes);
  return Object.keys(data.pods ?? {}).some((podUrl) => podUrlMatchesUsername(podUrl, username));
}

export async function retryRegistrationReadiness(
  options: RegistrationFlowOptions,
): Promise<RegistrationFlowResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { accountIndexUrl, accountToken, username } = options;
  const endpoints = await loadRegistrationAccountEndpoints(fetchImpl, accountIndexUrl, accountToken);
  const provisionTarget = await resolveCurrentProvisionTarget(options.provisionCode);
  const durableReady = await hasDurableExactBinding(
    fetchImpl,
    accountIndexUrl,
    endpoints,
    accountToken,
    username,
    provisionTarget?.storageRoot,
  );
  if (durableReady) {
    return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
  }

  let provisionCode: string | undefined;
  try {
    provisionCode = provisionTarget.activeProvisionCode ?? await resolveProvisionCodeForPodCreate(
      options.provisionCode,
    );
  } catch {
    throw new RegistrationProvisioningNotReadyError();
  }
  const ready = await checkRegistrationReadinessOnce(
    fetchImpl,
    accountIndexUrl,
    endpoints,
    accountToken,
    provisionCode,
    username,
    provisionTarget?.storageRoot,
  );
  if (!ready) {
    throw new RegistrationProvisioningNotReadyError();
  }

  return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
}

export async function completeRegistrationProvisioning(
  options: RegistrationFlowOptions,
): Promise<RegistrationFlowResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { accountIndexUrl, accountToken, username } = options;
  const endpoints = await loadRegistrationAccountEndpoints(fetchImpl, accountIndexUrl, accountToken);
  const createPodUrl = endpoints.pod;
  const webIdUrl = endpoints.webId;
  if (!createPodUrl) {
    throw new Error('Pod creation endpoint not found. The account API did not expose controls.account.pod.');
  }

  const provisionTarget = await resolveCurrentProvisionTarget(options.provisionCode);
  const durableReady = await hasDurableExactBinding(
    fetchImpl,
    accountIndexUrl,
    endpoints,
    accountToken,
    username,
    provisionTarget?.storageRoot,
  );
  if (durableReady) {
    return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
  }

  const provisionCode = provisionTarget.activeProvisionCode ?? await resolveProvisionCodeForPodCreate(
    options.provisionCode,
  );

  if (await hasExistingPod(fetchImpl, createPodUrl, webIdUrl, username, accountToken, provisionCode)) {
    if (!await defaultWaitForWebIdReady(fetchImpl, accountIndexUrl, endpoints, accountToken, 15_000, provisionCode, username)) {
      throw new RegistrationProvisioningNotReadyError();
    }
    return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
  }

  const preparedProvision = provisionCode
    ? await prepareProvisionedPod(fetchImpl, username, provisionCode)
    : undefined;

  const res = await fetchImpl(createPodUrl, {
    method: 'POST',
    headers: {
      ...accountTokenHeaders(accountToken),
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(buildPodCreatePayload(
      username,
      preparedProvision?.provisionCode ?? provisionCode,
      preparedProvision?.provisionReceipt,
    )),
  });
  if (!res.ok) {
    const message = await readErrorMessage(res);
    if (isUsernameConflict(message, username)) {
      throw new RegistrationError(
        xpodRegistrationCopy.usernameAlreadyTaken,
        'USERNAME_ALREADY_TAKEN',
      );
    }
    throw new Error(message || 'Failed to create pod');
  }
  const podCreateResult = await res.json().catch(() => ({})) as unknown;
  void podCreateResult;

  if (!await defaultWaitForWebIdReady(fetchImpl, accountIndexUrl, endpoints, accountToken, 15_000, provisionCode, username)) {
    throw new RegistrationProvisioningNotReadyError();
  }

  return { createdPod: true, redirectedToConsent: await hasPendingConsent(fetchImpl, accountToken) };
}

async function hasPendingConsent(fetchImpl: typeof fetch, accountToken: string): Promise<boolean> {
  const consentCheck = await fetchImpl('/.account/oidc/consent/', {
    headers: accountTokenHeaders(accountToken),
    credentials: 'include',
  } as RequestInit);
  if (consentCheck.ok) {
    const consentData = await consentCheck.json().catch(() => ({})) as ConsentCheckResponse;
    if (consentData.client) {
      return true;
    }
  }

  return false;
}
