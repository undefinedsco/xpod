export const REGISTRATION_USERNAME_MIN_LENGTH = 3;
export const REGISTRATION_USERNAME_MAX_LENGTH = 63;
export const REGISTRATION_USERNAME_PATTERN = /^[a-z0-9-]+$/;

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
