import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { deriveRefreshConfig, refreshPolicy } from './browserRefreshPolicy';

test('image config derivation preserves non-policy values and original input', () => {
  const original = readFileSync(new URL('../../config/main.json', import.meta.url), 'utf8');
  for (const profile of ['renew', 'idle', 'expire'] as const) {
    const result = deriveRefreshConfig(original, profile);
    assert.equal(result.policyChanges, 1);
    assert.notEqual(result.originalSha256, result.derivedSha256);
    assert.deepEqual(refreshPolicy(profile), { accessTokenTtl: 30, refreshTokenTtl: profile === 'expire' ? 5 : 180 });
    assert.equal(readFileSync(new URL('../../config/main.json', import.meta.url), 'utf8'), original);
  }
});

test('RDF JSON literal changes only allowed policy leaves', () => {
  const policy = { ttl: { AccessToken: 3600, RefreshToken: 1209600, IdToken: 123 }, clockTolerance: 15, unrelated: ['keep'] };
  const original = JSON.stringify({ '@type': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON', '@value': JSON.stringify(policy) });
  const literal = JSON.parse(JSON.parse(deriveRefreshConfig(original, 'expire').config)['@value']);
  assert.deepEqual(literal, { ...policy, ttl: { ...policy.ttl, AccessToken: 30, RefreshToken: 5 }, clockTolerance: 0 });
});

test('missing, ambiguous and malformed source policies fail closed', () => {
  const policy = { ttl: { AccessToken: 3600, RefreshToken: 1209600 } };
  for (const input of [{}, [policy, policy], { ttl: { AccessToken: '3600', RefreshToken: 5 } }]) {
    assert.throws(() => deriveRefreshConfig(JSON.stringify(input), 'renew'));
  }
  assert.throws(() => deriveRefreshConfig('{', 'renew'));
});

test('derive-config command writes private hash-bound outputs and refuses overwrite', () => {
  const parent = path.resolve('.test-data/refresh-policy-command');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'owned-'));
  const derived = path.join(root, 'derived.json');
  const receipt = path.join(root, 'policy.json');
  const args = ['scripts/accept-service-image-session.ts', 'derive-config', 'config/main.json', derived, 'idle', receipt];
  try {
    const result = spawnSync('bun', args, { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    const policy = JSON.parse(readFileSync(receipt, 'utf8'));
    const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(policy.originalConfigSHA256, sha('config/main.json'));
    assert.equal(policy.derivedConfigSHA256, sha(derived));
    assert.equal(policy.accessTokenTtl, 30);
    assert.equal(policy.refreshTokenTtl, 180);
    assert.equal(statSync(derived).mode & 0o777, 0o600);
    assert.equal(statSync(receipt).mode & 0o777, 0o600);
    assert.notEqual(spawnSync('bun', args, { encoding: 'utf8', timeout: 5000 }).status, 0);
    assert.equal(policy.derivedConfigSHA256, sha(derived));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
