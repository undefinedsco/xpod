import { createHash } from 'node:crypto';
import limits from '../module-artifact-limits.json';
import { candidateServiceRuntimeArtifactView } from './candidate-service-runtime-artifact';
import type { CandidateServiceRuntimeArtifactView, CandidateServiceRuntimeMember } from './candidate-service-runtime-artifact';

/**
 * Actual post-pack installed source slice. This adapter derives package roots
 * and complete per-package file sets only from the private, already-issued
 * runtime artifact view of the same stopped candidate container. It never
 * accepts a caller-supplied member list, package list or file list, and it
 * issues no whole-service source or legal authority.
 */
const APP = '/app';
const NODE_MODULES = 'node_modules';
const MANIFEST_MAXIMUM = 1024 * 1024;
const RANGE = limits.rangeBytes;
const SHA = /^[a-f0-9]{64}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function fail(message: string): never { throw Error('Candidate service installed source: ' + message); }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export type InstalledSourceMember = Readonly<{ path: string; absolutePath: string; type: 'file'; mode: number; bytes: number; sha256: string }>;
export type InstalledSourceMissingReason = 'symlinked-package-root' | 'unrecognized-package-manifest' | 'unowned-node-modules-file' | 'unowned-nested-file' | 'native-artifact-unmapped' | 'generated-or-unmapped';
export type InstalledSourceMissing = Readonly<{ path: string; reason: InstalledSourceMissingReason }>;
export type InstalledSourcePackage = Readonly<{
  name: string; version: string; sourceRoot: string; logicalPath: string;
  manifest: Readonly<{ path: string; bytes: number; sha256: string }>;
  members: readonly InstalledSourceMember[];
  readMemberRange(relativePath: string, offset: number, length: number): Buffer;
  assertCurrent(): void;
}>;
export type InstalledSourceInventory = Readonly<{
  packages: readonly InstalledSourcePackage[];
  missing: readonly InstalledSourceMissing[];
  assertCurrent(): void;
}>;

type InputMember = Readonly<{ path: string; type: 'file' | 'directory' | 'symlink'; mode: number; bytes: number; sha256?: string }>;

function packageRoot(value: string): string | undefined {
  if (!value.startsWith(APP + '/' + NODE_MODULES + '/')) return undefined;
  const parts = value.slice(APP.length + 1).split('/');
  let at = -1;
  for (let index = 0; index < parts.length; index++) if (parts[index] === NODE_MODULES) at = index;
  if (at < 0) return undefined;
  const tail = parts.slice(at + 1);
  const name = tail.length === 1 && PACKAGE_NAME.test(tail[0]!) ? tail[0]!
    : tail.length === 2 && /^@[a-z0-9][a-z0-9._-]*$/u.test(tail[0]!) && /^[a-z0-9][a-z0-9._-]*$/u.test(tail[1]!) ? tail[0] + '/' + tail[1]!
    : undefined;
  if (!name) return undefined;
  return APP + '/' + parts.slice(0, at + 1).join('/') + '/' + name;
}
function inside(root: string, path: string) { return path === root || path.startsWith(root + '/'); }
function relativeTo(root: string, path: string) { return path.slice(root.length + 1); }

/**
 * Mechanical inventory over already-observed runtime members. Exported for
 * focused tests only: without the private runtime issuance below it cannot
 * authorize installed bytes, and it still refuses any member outside /app.
 */
export function inspectCandidateServiceInstalledSource(input: {
  members: readonly InputMember[];
  readMemberRange(path: string, offset: number, length: number): Buffer;
  check?: () => void;
}): InstalledSourceInventory {
  const check = input.check ?? (() => {});
  if (!Array.isArray(input.members) || input.members.length === 0) fail('actual runtime member inventory required');
  check();
  const members = input.members.map(row => {
    if (!row || typeof row.path !== 'string' || !row.path.startsWith(APP + '/') || row.path.slice(1).split('/').some((part: string) => !part || part === '.' || part === '..')) fail('canonical actual /app runtime member required');
    if (!Number.isSafeInteger(row.mode) || row.mode < 0 || row.mode > 0o7777) fail('actual runtime member mode');
    if (row.type === 'file' && (typeof row.sha256 !== 'string' || !SHA.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)) fail('actual runtime file bytes/hash');
    return Object.freeze({ path: row.path, type: row.type, mode: row.mode, bytes: row.bytes, ...(row.type === 'file' ? { sha256: row.sha256! } : {}) });
  });
  const roots = new Set<string>(), missing: InstalledSourceMissing[] = [];
  const addMissing = (path: string, reason: InstalledSourceMissingReason) => { if (!missing.some(row => row.path === path)) missing.push(Object.freeze({ path, reason })); };
  for (const member of members) {
    if (!member.path.startsWith(APP + '/' + NODE_MODULES + '/')) continue;
    if (member.path.endsWith('/package.json')) {
      if (member.type !== 'file') { addMissing(member.path, 'symlinked-package-root'); continue; }
      const root = packageRoot(member.path.slice(0, -'/package.json'.length));
      if (root) roots.add(root);
      else addMissing(member.path, 'unrecognized-package-manifest');
    } else if (member.type === 'symlink' && member.path.split('/').pop() !== 'package.json') {
      // A symlinked package root has no regular manifest original to read.
      const root = packageRoot(member.path);
      if (root && !members.some(row => row.path === root + '/package.json')) addMissing(member.path, 'symlinked-package-root');
    }
  }
  const ordered = [...roots].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  if (!ordered.length) fail('no actual /app/node_modules package roots found');
  const owned = new Set<string>();
  const packages: InstalledSourcePackage[] = [];
  for (const root of ordered) {
    check();
    const descendants = ordered.filter(other => other !== root && inside(root, other));
    const manifestPath = root + '/package.json';
    const manifestMember = members.find(row => row.path === manifestPath);
    if (!manifestMember || manifestMember.type !== 'file') fail('actual package manifest original required');
    if (manifestMember.bytes > MANIFEST_MAXIMUM) fail('bounded actual package manifest required');
    const raw = Buffer.alloc(manifestMember.bytes);
    for (let offset = 0; offset < raw.length;) {
      check();
      const count = Math.min(RANGE, raw.length - offset);
      const block = input.readMemberRange(manifestPath, offset, count);
      if (!Buffer.isBuffer(block) || block.length !== count) fail('exact actual package manifest range');
      block.copy(raw, offset); offset += count;
    }
    check();
    if (sha(raw) !== manifestMember.sha256) fail('actual package manifest bytes differ from runtime original');
    let manifest: any;
    try { manifest = JSON.parse(raw.toString('utf8')); } catch { addMissing(manifestPath, 'unrecognized-package-manifest'); continue; }
    const leaf = root.slice(root.lastIndexOf('/' + NODE_MODULES + '/') + NODE_MODULES.length + 2);
    if (typeof manifest?.name !== 'string' || manifest.name !== leaf || !PACKAGE_NAME.test(manifest.name)
      || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
      // A manifest whose identity cannot be tied to this exact package root is
      // reported as an explicit gap, never coerced into a package claim.
      addMissing(manifestPath, 'unrecognized-package-manifest'); continue;
    }
    const files: InstalledSourceMember[] = [];
    for (const member of members) {
      if (!inside(root, member.path) || member.path === root) continue;
      if (descendants.some(other => inside(other, member.path))) continue;
      const relative = relativeTo(root, member.path);
      if (relative.split('/').includes(NODE_MODULES)) { addMissing(member.path, 'unowned-nested-file'); continue; }
      if (member.type === 'directory') continue; // Structural entries remain in the runtime cap; this inventory maps file originals.
      if (member.type !== 'file') { addMissing(member.path, 'generated-or-unmapped'); continue; }
      owned.add(member.path);
      files.push(Object.freeze({ path: relative, absolutePath: member.path, type: 'file' as const, mode: member.mode, bytes: member.bytes, sha256: member.sha256! }));
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    if (!files.length) fail('complete actual package file membership required');
    const names = new Set(files.map(row => row.path));
    const binding = Object.freeze({
      name: manifest.name, version: manifest.version, sourceRoot: root,
      logicalPath: root.slice(APP.length + 1),
      manifest: Object.freeze({ path: manifestPath, bytes: manifestMember.bytes, sha256: manifestMember.sha256 }),
      members: Object.freeze(files),
      readMemberRange(relativePath: string, offset: number, length: number) {
        check();
        if (!names.has(relativePath) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > RANGE) fail('bounded actual package file range required');
        const row = files.find(item => item.path === relativePath)!;
        if (offset + length > row.bytes) fail('actual package file range exceeds member');
        const bytes = input.readMemberRange(row.absolutePath, offset, length);
        if (!Buffer.isBuffer(bytes) || bytes.length !== length) fail('exact actual package file range');
        return Buffer.from(bytes);
      },
      assertCurrent() { check(); },
    });
    packages.push(binding);
  }
  for (const member of members) {
    if (member.path === APP + '/' + NODE_MODULES || member.path.startsWith(APP + '/' + NODE_MODULES + '/')) {
      if (!owned.has(member.path) && !missing.some(row => row.path === member.path) && member.type === 'file') addMissing(member.path, 'unowned-node-modules-file');
    }
  }
  const packageList = Object.freeze(packages), missingList = Object.freeze(missing);
  return Object.freeze({ packages: packageList, missing: missingList, assertCurrent() { check(); for (const pkg of packageList) pkg.assertCurrent(); } });
}

const issued = new WeakMap<object, Readonly<{ originals: unknown; source: unknown; runtime: unknown; assertCurrent(): void }>>();
/** Exact lookup for this module's issued inventory on the very same private
 * handles plus the actual runtime capability it was derived from. */
export function candidateServiceInstalledSourceView(value: unknown, originals: unknown, source: unknown, runtime: unknown): InstalledSourceInventory | undefined {
  const row = value && typeof value === 'object' ? issued.get(value as InstalledSourceInventory) : undefined;
  if (!row || row.originals !== originals || row.source !== source || row.runtime !== runtime) return undefined;
  row.assertCurrent();
  return value as InstalledSourceInventory;
}

/** Private issuance from the same runtime artifact capability and inherited
 * service budget. No new byte allowance is created and no caller list is read. */
export function observeCandidateServiceInstalledSource(input: { originals: unknown; source: unknown; runtime: unknown; budget: { check(): void; remainingMs(): number } }): InstalledSourceInventory {
  const runtime = candidateServiceRuntimeArtifactView(input.runtime, input.originals, input.source);
  if (!runtime) fail('same issued actual runtime artifact and source handles required');
  const budget = input.budget;
  if (!budget || typeof budget.check !== 'function' || typeof budget.remainingMs !== 'function') fail('inherited service budget required');
  const check = () => { budget.check(); if (!Number.isFinite(budget.remainingMs()) || budget.remainingMs() <= 0) fail('inherited service deadline exhausted'); };
  check();
  const inventory = inspectCandidateServiceInstalledSource({
    members: runtime.members.filter(row => row.path.startsWith(APP + '/')),
    readMemberRange: (path, offset, length) => { check(); const bytes = runtime.readMemberRange(path, offset, length); check(); return bytes; },
    check,
  });
  const value = Object.freeze({
    packages: inventory.packages,
    missing: inventory.missing,
    assertCurrent() { check(); if (candidateServiceRuntimeArtifactView(input.runtime, input.originals, input.source) !== runtime) fail('actual runtime capability changed'); runtime.assertCurrent(); inventory.assertCurrent(); },
  });
  issued.set(value, Object.freeze({ originals: input.originals, source: input.source, runtime: input.runtime, assertCurrent: () => value.assertCurrent() }));
  return value;
}

/** Mechanical join of the actual installed package file universe to one
 * reviewed official projection. Mapped files must match sha/mode/size; every
 * extra runtime file is returned explicitly (native/generated/unmapped)
 * instead of being omitted. A projected file absent from the actual package
 * fails closed because the installed package is incomplete. */
export function compareCandidateServiceInstalledPackage(input: {
  pkg: InstalledSourcePackage;
  expected: ReadonlyMap<string, Readonly<{ bytes: number; sha256: string }>>;
  modes: ReadonlyMap<string, number>;
}) {
  const { pkg, expected, modes } = input;
  const actual = new Map(pkg.members.map(row => [row.path, row]));
  const missing: InstalledSourceMissing[] = [];
  for (const [path, row] of expected) {
    const found = actual.get(path);
    if (!found) fail('official projected package file absent from actual runtime: ' + pkg.name + '@' + pkg.version + ' ' + path);
    const mode = modes.get(path);
    if (mode === undefined) fail('official registry mode missing for mapped file: ' + path);
    if (found.bytes !== row.bytes || found.sha256 !== row.sha256 || found.mode !== mode) fail('actual runtime file differs from official projection: ' + pkg.sourceRoot + '/' + path);
  }
  for (const row of pkg.members) {
    if (expected.has(row.path)) continue;
    const reason: InstalledSourceMissingReason = /(?:^|\/)\.node$/u.test(row.path) || /(?:^|\/)(?:build|prebuilds)\//u.test(row.path) ? 'native-artifact-unmapped' : 'generated-or-unmapped';
    missing.push(Object.freeze({ path: row.absolutePath, reason }));
  }
  return Object.freeze({ matched: expected.size, missing: Object.freeze(missing) });
}
