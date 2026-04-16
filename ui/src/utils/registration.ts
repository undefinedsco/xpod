export const REGISTRATION_USERNAME_MIN_LENGTH = 3;
export const REGISTRATION_USERNAME_MAX_LENGTH = 63;
export const REGISTRATION_USERNAME_PATTERN = /^[a-z0-9-]+$/;

export interface RegistrationUsernameAvailability {
  available: boolean;
  suggestions: string[];
}

export function normalizeRegistrationUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function getRegistrationUsernameError(username: string): string | undefined {
  const normalizedUsername = normalizeRegistrationUsername(username);

  if (!normalizedUsername) {
    return 'Username is required';
  }

  if (
    normalizedUsername.length < REGISTRATION_USERNAME_MIN_LENGTH ||
    normalizedUsername.length > REGISTRATION_USERNAME_MAX_LENGTH
  ) {
    return `Username must be ${REGISTRATION_USERNAME_MIN_LENGTH}-${REGISTRATION_USERNAME_MAX_LENGTH} characters`;
  }

  if (!REGISTRATION_USERNAME_PATTERN.test(normalizedUsername)) {
    return 'Username can only contain lowercase letters, numbers, and hyphens';
  }

  if (normalizedUsername.startsWith('-') || normalizedUsername.endsWith('-')) {
    return 'Username cannot start or end with a hyphen';
  }

  return undefined;
}

export function makeRegistrationUsernameSuggestions(username: string, count = 5): string[] {
  const normalizedUsername = normalizeRegistrationUsername(username)
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, REGISTRATION_USERNAME_MAX_LENGTH - 3);

  const base = normalizedUsername || 'user';
  const suffixes = Array.from({ length: Math.max(count, 3) }, (_, index) => `${base}-${index + 1}`);

  return Array.from(new Set(
    suffixes
      .map((candidate) => candidate.slice(0, REGISTRATION_USERNAME_MAX_LENGTH))
      .filter((candidate) => !getRegistrationUsernameError(candidate)),
  )).slice(0, count);
}

function getIdentityApiBaseUrl(idpIndex: string): string {
  if (typeof window !== 'undefined') {
    return '/api/v1/identity';
  }

  try {
    const url = new URL(idpIndex);
    if (url.hostname.startsWith('id.')) {
      return `${url.protocol}//api.${url.hostname.slice(3)}/api/v1/identity`;
    }
    return `${url.origin}/api/v1/identity`;
  } catch {
    return '/api/v1/identity';
  }
}

async function fetchUsernameExists(
  username: string,
  idpIndex: string,
  fetchImpl: typeof fetch,
): Promise<boolean | undefined> {
  const endpoint = `${getIdentityApiBaseUrl(idpIndex)}/${encodeURIComponent(username)}`;

  try {
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });

    if (response.status === 404) {
      return false;
    }

    if (response.ok || response.status === 409) {
      return true;
    }
  } catch {
    // Ignore transient availability-check failures and let submit path re-check.
  }

  return undefined;
}

async function resolveAvailableSuggestions(
  username: string,
  idpIndex: string,
  fetchImpl: typeof fetch,
  count = 3,
): Promise<string[]> {
  const candidates = makeRegistrationUsernameSuggestions(username, Math.max(count * 2, 5));
  const suggestions: string[] = [];

  for (const candidate of candidates) {
    const exists = await fetchUsernameExists(candidate, idpIndex, fetchImpl);
    if (exists === false) {
      suggestions.push(candidate);
    }
    if (suggestions.length >= count) {
      break;
    }
  }

  return suggestions;
}

export async function checkRegistrationUsernameAvailability(
  username: string,
  idpIndex: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrationUsernameAvailability> {
  const normalizedUsername = normalizeRegistrationUsername(username);
  const formatError = getRegistrationUsernameError(normalizedUsername);

  if (formatError) {
    return {
      available: false,
      suggestions: [],
    };
  }
  const exists = await fetchUsernameExists(normalizedUsername, idpIndex, fetchImpl);
  if (exists === false || exists === undefined) {
    return { available: true, suggestions: [] };
  }

  return {
    available: false,
    suggestions: await resolveAvailableSuggestions(normalizedUsername, idpIndex, fetchImpl),
  };
}
