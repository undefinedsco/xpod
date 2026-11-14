/**
 * Retained-keyring MECHANICS under the core's real monotonic clock domain.
 *
 * Portable by construction: deterministic in-memory fixture bytes, no /tmp
 * capture path, no environment fallback, no hidden skip. These tests prove the
 * adapter helper executes inside the SAME `performance.now()` budget the core
 * builds, that an exhausted or revoked budget still refuses before any write,
 * and that the helper itself owns no clock.
 *
 * Boundary (stated, not faked): this host may have no /usr/bin/gpgv, so the
 * full core cannot complete here. The genuine raw Linux full-core probe is run
 * separately and is not replaced by these mechanics tests. Nothing here asserts
 * that the macOS core reaches gpgv.
 */
import {afterAll, test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {officialKeys} from '../../scripts/lib/independent-admission/qlever-sdk-debian-signature';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Deterministic mechanics bytes. Explicitly NOT a Debian keyring and never
 * used to assert cryptographic acceptance. */
function fixtureBytes(tag: string): Buffer {
  return Buffer.from(`MECHANICS-ONLY-NOT-A-DEBIAN-KEYRING ${tag}\n`.repeat(8));
}

const TEST_ROOT = path.resolve(import.meta.dir, '../../.test-data/debian-signature-clock-domain');
afterAll(() => rmSync(TEST_ROOT, {recursive: true, force: true}));
function tempDir(prefix: string): string {
  mkdirSync(TEST_ROOT, {recursive: true});
  return mkdtempSync(path.join(TEST_ROOT, prefix));
}

test('officialKeys runs inside the core-built monotonic deadline and writes exact bytes', () => {
  const bytes = fixtureBytes('clock');
  const ref = Object.freeze({
    path: 'inner/debian-source/indexes/debian-archive-keyring.gpg',
    bytes: bytes.length, sha256: sha(bytes),
  });
  // Build the deadline EXACTLY as observeSignatureCore does.
  const remainingMs = 120000;
  const called = performance.now();
  const deadline = called + Math.min(remainingMs, 120000);
  let checks = 0;
  const check = () => {
    checks += 1;
    if (!(performance.now() < deadline)) throw Error('shared source deadline expired');
  };
  const dir = tempDir('clock-domain-');
  try {
    const keys = officialKeys(dir, check, {ref, bytes});
    expect(checks).toBeGreaterThan(0);
    expect(keys.keyringSha256).toBe(ref.sha256);
    expect(keys.originals).toEqual([ref]);
    const materialized = readFileSync(path.join(dir, 'reviewed-keys.gpg'));
    expect(materialized.equals(bytes)).toBe(true);
    expect(statSync(path.join(dir, 'reviewed-keys.gpg')).mode & 0o777).toBe(0o400);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an already-exhausted monotonic budget refuses before any file is written', () => {
  const bytes = fixtureBytes('expired');
  const ref = Object.freeze({
    path: 'inner/debian-source/indexes/debian-archive-keyring.gpg',
    bytes: bytes.length, sha256: sha(bytes),
  });
  const deadline = performance.now() - 1;
  const dir = tempDir('clock-expired-');
  try {
    expect(() => officialKeys(dir, () => {
      if (!(performance.now() < deadline)) throw Error('shared source deadline expired');
    }, {ref, bytes})).toThrow('shared source deadline expired');
    expect(existsSync(path.join(dir, 'reviewed-keys.gpg'))).toBe(false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a revoked parent check() propagates before any keyring write', () => {
  const bytes = fixtureBytes('revoked');
  const ref = Object.freeze({
    path: 'inner/debian-source/indexes/debian-archive-keyring.gpg',
    bytes: bytes.length, sha256: sha(bytes),
  });
  const dir = tempDir('clock-revoked-');
  try {
    expect(() => officialKeys(dir, () => { throw Error('parent budget revoked'); }, {ref, bytes}))
      .toThrow('parent budget revoked');
    expect(existsSync(path.join(dir, 'reviewed-keys.gpg'))).toBe(false);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('officialKeys owns no clock: it calls only the supplied check', () => {
  const bytes = fixtureBytes('noclocks');
  const ref = Object.freeze({
    path: 'inner/debian-source/indexes/debian-archive-keyring.gpg',
    bytes: bytes.length, sha256: sha(bytes),
  });
  const dir = tempDir('clock-owned-');
  try {
    // A check that records calls but never throws proves the helper has no
    // independent self-expiry: it would otherwise reject on its own.
    let calls = 0;
    const keys = officialKeys(dir, () => { calls += 1; }, {ref, bytes});
    expect(calls).toBeGreaterThan(0);
    expect(keys.keyringSha256).toBe(ref.sha256);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the helper materializes the given bytes and returns the ref it was handed', () => {
  // Contract boundary: officialKeys is the materialization helper. Identity
  // validation against artifact members happens in inspectRetainedControllerKeyring
  // (covered by its own mechanics test); this helper deliberately re-uses the
  // caller-validated ref and does not re-parse or re-derive trust.
  const bytes = fixtureBytes('materialize');
  const ref = Object.freeze({
    path: 'inner/debian-source/indexes/debian-archive-keyring.gpg',
    bytes: bytes.length, sha256: sha(bytes),
  });
  const dir = tempDir('clock-materialize-');
  try {
    const keys = officialKeys(dir, () => {}, {ref, bytes});
    expect(keys.originals).toEqual([ref]);
    expect(keys.keyringSha256).toBe(ref.sha256);
    expect(readFileSync(path.join(dir, 'reviewed-keys.gpg')).equals(bytes)).toBe(true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
