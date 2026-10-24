/**
 * Pure product-role plan for candidate-service native members. It reads only
 * bounded original headers, issues no ABI/legal/release capability, and never
 * accepts a caller-asserted ELF/format claim.
 */
export type CandidateServiceTarget = 'linux-x64' | 'linux-arm64';
export type CandidateServiceNativeRole = 'qlever-runtime' | 'bun-node-addon' | 'bun-sqlite-extension' | 'inngest-cli';
export interface CandidateServiceNativeMember {
  readonly path: string; readonly mode: number; readonly bytes: number; readonly sha256: string;
}
export interface CandidateServiceNativeRoleInput {
  readonly target: CandidateServiceTarget;
  readonly members: readonly CandidateServiceNativeMember[];
  readHeader(path: string, maximum: number): Buffer;
  check(): void;
}
export interface CandidateServiceRoleRule {
  readonly role: CandidateServiceNativeRole;
  readonly root: '/' | '/app';
  readonly match: (path: string) => boolean;
  readonly executable: boolean;
  /** Exactly these real ELF e_type values are admitted for the role. */
  readonly eTypes: readonly number[];
}
const under = (root: string, path: string) => path === root || path.startsWith(root + '/');
/** ONE declarative table of exact actual repository roles; nothing else is a role. */
export const CANDIDATE_SERVICE_NATIVE_ROLE_RULES: readonly CandidateServiceRoleRule[] = Object.freeze([
  Object.freeze({ role: 'qlever-runtime' as const, root: '/' as const,
    match: (path: string) => under('/opt/xpod/qlever', path) && path.length > '/opt/xpod/qlever/'.length,
    executable: true, eTypes: Object.freeze([2, 3]) }),
  Object.freeze({ role: 'bun-node-addon' as const, root: '/app' as const,
    match: (path: string) => /^\/app\/node_modules\/classic-level\/prebuilds\/[^/]+\/[^/]+\.node$/u.test(path),
    executable: false, eTypes: Object.freeze([3]) }),
  Object.freeze({ role: 'bun-sqlite-extension' as const, root: '/app' as const,
    match: (path: string) => /^\/app\/node_modules\/sqlite-vec-(?:linux-x64|linux-arm64)\/vec0\.so$/u.test(path),
    executable: false, eTypes: Object.freeze([3]) }),
  Object.freeze({ role: 'inngest-cli' as const, root: '/app' as const,
    match: (path: string) => path === '/app/node_modules/inngest-cli/bin/inngest',
    executable: true, eTypes: Object.freeze([2, 3]) }),
]);
export type CandidateServiceNativeHeader = Readonly<{
  format: 'elf'; elfClass: number; byteOrder: 'little'; type: number; machine: 62 | 183;
}>;
export type CandidateServiceNativeRoleResult = Readonly<{
  target: CandidateServiceTarget;
  roles: readonly Readonly<{ path: string; mode: number; bytes: number; sha256: string; role: CandidateServiceNativeRole }>[];
  unresolved: readonly Readonly<{ path: string; reason: string }>[];
  /** No ABI, runtime-completeness or release claim is made here. */
  scope: 'mechanical native product role plan only; no ABI, runtime completeness or release qualification';
}>;
const fail = (message: string): never => { throw Error('Candidate service native roles: ' + message); };
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const absolute = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.includes('\\')
  && !/[\u0000-\u001f\u007f]/u.test(path) && path.split('/').slice(1).every(part => part.length > 0 && part !== '.' && part !== '..');
export function inspectCandidateServiceNativeHeader(header: Buffer, target: CandidateServiceTarget): CandidateServiceNativeHeader | string {
  const read = (offset: number): number => header[offset] ?? 0;
  if (header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a) return 'foreign-pe-product-boundary:unsupported';
  if (header.length < 4) return 'non-native';
  const magic = [read(0), read(1), read(2), read(3)];
  if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) return /^(feedface|cefaedfe|feedfacf|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)$/u.test(header.subarray(0,4).toString('hex')) ? 'foreign-macho-product-boundary:unsupported' : 'non-native';
  if (header.length < 64) return 'short-elf-header';
  if (read(4) !== 2) return 'not-elf64';
  if (read(5) !== 1) return 'not-little-endian';
  if (read(6) !== 1 || header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) return 'invalid-elf-version-or-header-size';
  const expected = target === 'linux-x64' ? 62 : 183;
  if (read(18) !== expected || read(19) !== 0) return 'wrong-architecture';
  const type = read(16) | read(17) << 8;
  return Object.freeze({ format: 'elf' as const, elfClass: 2, byteOrder: 'little' as const, type, machine: expected as 62 | 183 });
}

/** Deterministic product role plan. Unknown/foreign/wrong-target files become
 * exact unresolved product-boundary rows and are retained by membership identity. */
export function inspectCandidateServiceNativeRoles(input: CandidateServiceNativeRoleInput): CandidateServiceNativeRoleResult {
  const { target, members, readHeader, check } = input;
  if (target !== 'linux-x64' && target !== 'linux-arm64') return fail('supported linux target required');
  if (typeof readHeader !== 'function' || typeof check !== 'function') return fail('header reader and parent check required');
  if (!Array.isArray(members) || members.length > 100000) return fail('bounded member inventory required');
  check();
  const seen = new Set<string>(), roles: Array<Readonly<{
    path: string; mode: number; bytes: number; sha256: string; role: CandidateServiceNativeRole }>> = [], unresolved: Array<Readonly<{ path: string; reason: string }>> = [];
  for (const member of members) {
    check();
    if (!member || typeof member !== 'object') return fail('plain member identity required');
    const { path, mode, bytes, sha256: digest } = member;
    if (!absolute(path)) return fail('safe unique absolute member path required');
    if (seen.has(path)) return fail('duplicate member path: ' + path);
    seen.add(path);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) return fail('safe member mode required: ' + path);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return fail('bounded member byte length required: ' + path);
    if (!sha256(digest)) return fail('canonical member sha256 required: ' + path);
    const rule = CANDIDATE_SERVICE_NATIVE_ROLE_RULES.find(candidate => candidate.match(path));
    const header = readHeader(path, Math.min(bytes,64));
    if (!Buffer.isBuffer(header)) return fail('header reader must return original bytes: ' + path);
    if (header.length !== Math.min(bytes,64)) return fail('bounded original header required: ' + path);
    const inspection = inspectCandidateServiceNativeHeader(header, target);
    if (inspection === 'non-native') continue;
    const identity = Object.freeze({ path, mode, bytes, sha256: digest });
    if (typeof inspection === 'string') {
      unresolved.push(Object.freeze({ path, reason: inspection.startsWith('foreign-') ? inspection + ':' + (rule?.role ?? 'unassigned') : inspection }));
      continue;
    }
    if (!rule) { unresolved.push(Object.freeze({path,reason:'native-member-without-product-role'})); continue; }
    if (rule.executable && path.includes('/bin/') && !(mode & 0o111)) { unresolved.push(Object.freeze({path,reason:'native-executable-mode-required'})); continue; }
    if (!rule.eTypes.includes(inspection.type)) {
      unresolved.push(Object.freeze({ path, reason: 'elf-type-not-role-admissible:' + inspection.type + ':' + rule.role }));
      continue;
    }
    roles.push(Object.freeze({ ...identity, role: rule.role }));
  }
  check();
  return Object.freeze({ target, roles: Object.freeze(roles), unresolved: Object.freeze(unresolved),
    scope: 'mechanical native product role plan only; no ABI, runtime completeness or release qualification' as const });
}

