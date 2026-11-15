import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { PROFILES } = createRequire(import.meta.url)('../../scripts/lib/service-image-session-contract.cjs');

export type RefreshProfile = 'renew' | 'idle' | 'expire';

export function refreshPolicy(profile: RefreshProfile): { accessTokenTtl: number; refreshTokenTtl: number } {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) throw new Error('Invalid refresh profile');
  return { ...PROFILES[profile] };
}

/** Derive deployment policy only; preserve every other value from the image config. */
export function deriveRefreshConfig(original: string, profile: RefreshProfile): {
  config: string; originalSha256: string; derivedSha256: string; policyChanges: number;
} {
  const policy = refreshPolicy(profile);
  const source: unknown = JSON.parse(original);
  const derived: unknown = JSON.parse(original);
  let policyChanges = 0;
  function visit(value: unknown, change: boolean): void {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record['@value'] === 'string' && record['@type'] === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON') {
      const literal: unknown = JSON.parse(record['@value']);
      visit(literal, change);
      record['@value'] = JSON.stringify(literal);
      return;
    }
    const ttl = record.ttl as Record<string, unknown> | undefined;
    if (ttl && typeof ttl === 'object' && 'AccessToken' in ttl && 'RefreshToken' in ttl) {
      if (![ttl.AccessToken, ttl.RefreshToken].every(v => Number.isSafeInteger(v) && Number(v) > 0)) {
        throw new Error('Invalid source token policy');
      }
      if (change) policyChanges += 1;
      // Normalize precisely these three permitted leaves on both sides for comparison.
      ttl.AccessToken = change ? policy.accessTokenTtl : 0;
      ttl.RefreshToken = change ? policy.refreshTokenTtl : 0;
      record.clockTolerance = change ? 0 : null;
    }
    for (const child of Object.values(record)) visit(child, change);
  }
  visit(derived, true);
  if (policyChanges !== 1) throw new Error('Expected exactly one IdP token policy');
  const config = `${JSON.stringify(derived, null, 2)}\n`;
  const normalizedDerived: unknown = JSON.parse(config);
  visit(source, false);
  visit(normalizedDerived, false);
  if (JSON.stringify(source) !== JSON.stringify(normalizedDerived)) throw new Error('Non-policy config changed');
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  return { config, originalSha256: sha(original), derivedSha256: sha(config), policyChanges };
}
