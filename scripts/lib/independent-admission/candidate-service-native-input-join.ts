/** Pure mechanical join only. This module is not a capability issuer and reads
 * no filesystem, network or crypto policy. Inputs are declarations, not
 * authority: the caller must obtain them from actual private views/replay.
 *
 * - reads may be satisfied by authenticated git/sdk/debian rows or by
 *   replay-proven generated rows;
 * - tools may only be satisfied by authenticated git/sdk/debian rows, because
 *   generated output cannot authenticate an executed tool;
 * - duplicate snapshots with different contents are preserved, never collapsed
 *   by path;
 * - conflicting identities inside git/sdk/debian are rejected, while distinct
 *   generated versions of one path are accepted.
 */

export type NativeInputSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  mode: number;
}>;

export type NativeInputJoinInput = Readonly<{
  reads?: readonly NativeInputSnapshot[];
  tools?: readonly NativeInputSnapshot[];
  generated?: readonly NativeInputSnapshot[];
  git?: readonly NativeInputSnapshot[];
  sdk?: readonly NativeInputSnapshot[];
  debian?: readonly NativeInputSnapshot[];
  /** Full canonical authenticated upstream/FetchContent source rows. Only
   * applicable notices are consulted; source/toolchain trees stay excluded. */
  sourceOriginals?: readonly NativeInputSnapshot[];
}>;

export type NativeInputCovered = NativeInputSnapshot & Readonly<{
  kind: 'reads' | 'tools';
  via: 'git' | 'sdk' | 'debian' | 'generated';
}>;

export type NativeInputUnresolved = NativeInputSnapshot & Readonly<{
  kind: 'reads' | 'tools';
  reason: string;
}>;

export type NativeInputJoinResult = Readonly<{
  covered: readonly NativeInputCovered[];
  unresolved: readonly NativeInputUnresolved[];
  sourceAuthorityVerified: false;
}>;

const SHA = /^[a-f0-9]{64}$/u;
const AUTHORITY = ['git', 'sdk', 'debian'] as const;
type Authority = typeof AUTHORITY[number];
const KINDS = ['reads', 'tools'] as const;
type Kind = typeof KINDS[number];

function need(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error('Native input join: ' + why);
}

function canonical(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 2 || !path.startsWith('/') || path.endsWith('/')) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  const parts = path.slice(1).split('/');
  return parts.length > 0 && parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

function copy(value: NativeInputSnapshot, context: string): NativeInputSnapshot {
  need(value && typeof value === 'object', context + ' row object required');
  need(canonical(value.path), context + ' canonical absolute path required');
  need(Number.isSafeInteger(value.bytes) && value.bytes >= 0, context + ' integer bytes required');
  need(Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777,
    context + ' integer permission mode required');
  need(typeof value.sha256 === 'string' && SHA.test(value.sha256), context + ' lowercase SHA-256 required');
  return Object.freeze({path: value.path, bytes: value.bytes, sha256: value.sha256, mode: value.mode});
}

function list(value: unknown, label: string): readonly NativeInputSnapshot[] {
  if (value === undefined) return Object.freeze([]) as readonly NativeInputSnapshot[];
  need(Array.isArray(value), label + ' must be an array');
  need(value.length <= 100000, label + ' bounded row count required');
  return Object.freeze(value.map((row, index) => copy(row, label + '[' + String(index) + ']')));
}

function same(a: NativeInputSnapshot, b: NativeInputSnapshot): boolean {
  return a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256 && a.mode === b.mode;
}

function validateAuthority(rows: readonly NativeInputSnapshot[], label: Authority): readonly NativeInputSnapshot[] {
  const seen = new Map<string, NativeInputSnapshot>();
  for (const row of rows) {
    const prior = seen.get(row.path);
    if (prior) {
      need(same(prior, row), label + ' conflicts with itself for path ' + row.path);
      continue;
    }
    seen.set(row.path, row);
  }
  return Object.freeze([...seen.values()]);
}

const NOTICE = /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu;
/** Only applicable notice basenames from the same authenticated universe. */
export function applicableSourceNotices(rows: readonly NativeInputSnapshot[]): readonly NativeInputSnapshot[] {
  const seen = new Map<string, NativeInputSnapshot>();
  for (const row of list(rows, 'sourceOriginals')) {
    if (!NOTICE.test(row.path.slice(row.path.lastIndexOf('/') + 1))) continue;
    const prior = seen.get(row.path);
    if (prior) { need(same(prior, row), 'source notice conflicts for path ' + row.path); continue; }
    seen.set(row.path, row);
  }
  return Object.freeze([...seen.values()]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const row of Object.values(value)) deepFreeze(row);
    Object.freeze(value);
  }
  return value;
}

/** Match exact path+bytes+SHA+mode. Authority order is git, sdk, debian. */
function matchAuthority(row: NativeInputSnapshot, authorities: ReadonlyMap<Authority, readonly NativeInputSnapshot[]>): NativeInputCovered | undefined {
  for (const name of AUTHORITY) {
    const found = authorities.get(name)!.find(value => same(value, row));
    if (found) return Object.freeze({...found, kind: 'reads' as const, via: name});
  }
  return undefined;
}

function matchGenerated(row: NativeInputSnapshot, generated: readonly NativeInputSnapshot[]): NativeInputSnapshot | undefined {
  return generated.find(value => same(value, row));
}

export function joinNativeInputSnapshots(input: NativeInputJoinInput): NativeInputJoinResult {
  need(input && typeof input === 'object', 'input object required');
  const declared: Record<Kind, readonly NativeInputSnapshot[]> = {
    reads: list(input.reads, 'reads'),
    tools: list(input.tools, 'tools'),
  };
  const authorities = new Map<Authority, readonly NativeInputSnapshot[]>();
  for (const name of AUTHORITY) authorities.set(name, validateAuthority(list((input as any)[name], name), name));
  // Distinct generated versions of the same path are allowed.
  const generated = list(input.generated, 'generated');

  const covered: NativeInputCovered[] = [];
  const unresolved: NativeInputUnresolved[] = [];
  for (const kind of KINDS) {
    for (const row of declared[kind]) {
      const authority = matchAuthority(row, authorities);
      if (authority) {
        covered.push(Object.freeze({...authority, kind}));
        continue;
      }
      if (kind === 'reads' && matchGenerated(row, generated)) {
        covered.push(Object.freeze({...row, kind, via: 'generated'}));
        continue;
      }
      if (kind === 'reads') {
        const notice = applicableSourceNotices(input.sourceOriginals ?? []).find(value => same(value, row));
        if (notice) { covered.push(Object.freeze({...row, kind, via: 'sdk'})); continue; }
      }
      const reason = kind === 'tools'
        ? (matchGenerated(row, generated) ? 'generated-row-cannot-authorize-tool' : 'no-authenticated-tool-source')
        : 'no-authenticated-source';
      unresolved.push(Object.freeze({...row, kind, reason}));
    }
  }
  return deepFreeze({
    covered: Object.freeze(covered),
    unresolved: Object.freeze(unresolved),
    sourceAuthorityVerified: false as const,
  });
}
