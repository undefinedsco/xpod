export function isSecretEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized.endsWith('_KEY_PATH') || normalized.endsWith('_CERT_PATH')) {
    return false;
  }
  return (
    normalized.includes('AUTHTOKEN') ||
    normalized.endsWith('_TOKEN') ||
    normalized.endsWith('_SECRET') ||
    normalized.endsWith('_API_KEY') ||
    normalized.includes('PASSWORD') ||
    normalized.includes('CLIENT_SECRET') ||
    normalized.endsWith('_DB_URL') ||
    normalized.includes('DATABASE_URL')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactConfiguredLogSecrets(message: string, env: Record<string, string | undefined>): string {
  let sanitized = message;
  const secretEntries = Object.entries(env)
    .filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return isSecretEnvKey(key) && typeof value === 'string' && value.length >= 6;
    })
    .sort((a, b) => b[1].length - a[1].length);

  for (const [key, value] of secretEntries) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'g'), `[redacted:${key}]`);
  }
  return sanitized;
}
