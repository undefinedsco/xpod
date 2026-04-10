import { buildPodCreatePayload, clearStoredProvisionCode } from './pod';

export interface RegistrationFlowResult {
  redirectedToConsent: boolean;
}

export interface RegistrationFlowOptions {
  fetchImpl?: typeof fetch;
  idpIndex: string;
  username: string;
  enableManagedProfile?: boolean;
}

export async function defaultWaitForWebIdReady(
  fetchImpl: typeof fetch,
  idpIndex: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pickWebIdUrl = `${idpIndex}oidc/pick-webid/`;

  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(pickWebIdUrl, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      } as RequestInit);
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as any;
        const ids = Array.isArray(data.webIds) ? data.webIds : [];
        if (ids.length > 0) {
          return true;
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
  const { idpIndex, username, enableManagedProfile = true } = options;

  const profileRes = await fetchImpl('/api/v1/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      username,
      storageMode: 'local',
    }),
  });
  if (!profileRes.ok && profileRes.status !== 409 && profileRes.status !== 404) {
    throw new Error((await profileRes.json().catch(() => ({})) as any).message || 'Failed to create WebID profile');
  }

  let res = await fetchImpl(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' } as RequestInit);
  const accountData = await res.json().catch(() => ({})) as any;
  const createPodUrl = accountData.controls?.account?.pod;
  const linkWebIdUrl = accountData.controls?.account?.webId;
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
    const podError = await res.json().catch(() => ({}));
    throw new Error((podError as any).message || 'Failed to create pod');
  }
  const podCreateResult = await res.json().catch(() => ({})) as any;
  clearStoredProvisionCode();

  const storageUrl =
    typeof podCreateResult.podUrl === 'string' && podCreateResult.podUrl.length > 0
      ? podCreateResult.podUrl
      : undefined;
  if (storageUrl) {
    await fetchImpl(`/api/v1/identity/${encodeURIComponent(username)}/storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        storageUrl,
        storageMode: 'local',
      }),
    } as RequestInit).catch(() => undefined);
  }

  if (enableManagedProfile && profileRes.status !== 404 && linkWebIdUrl) {
    const profileLookupRes = await fetchImpl(`/api/v1/identity/${encodeURIComponent(username)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    } as RequestInit);
    if (!profileLookupRes.ok) {
      throw new Error((await profileLookupRes.json().catch(() => ({})) as any).message || 'Failed to load WebID profile');
    }
    const profile = await profileLookupRes.json().catch(() => ({})) as any;
    const webIdUrl = typeof profile.webidUrl === 'string' ? profile.webidUrl : '';
    if (!webIdUrl) {
      throw new Error('WebID profile URL missing');
    }

    const linkRes = await fetchImpl(linkWebIdUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webId: webIdUrl }),
    });
    if (!linkRes.ok) {
      throw new Error((await linkRes.json().catch(() => ({})) as any).message || 'Failed to link WebID');
    }

    const pickWebIdRes = await fetchImpl(`${idpIndex}oidc/pick-webid/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ webId: webIdUrl, remember: false }),
    });
    if (!pickWebIdRes.ok) {
      throw new Error((await pickWebIdRes.json().catch(() => ({})) as any).message || 'Failed to select WebID');
    }
  }

  await defaultWaitForWebIdReady(fetchImpl, idpIndex);

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
