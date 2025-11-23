import { createHash } from 'node:crypto';

/**
 * Convert ACME key authorization into DNS-01 TXT record value.
 */
export function toDns01Value(keyAuthorization: string): string {
  const hash = createHash('sha256')
    .update(keyAuthorization)
    .digest('base64');

  return hash
    .replace(/=+$/u, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');
}
