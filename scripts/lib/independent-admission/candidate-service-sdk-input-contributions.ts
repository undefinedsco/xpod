import {qleverSdkDebianBinaryObservation} from './qlever-sdk-debian-binary';
import {qleverSdkExecutionOriginalObservation, qleverSdkPostpatchSourceReadCaptures} from './qlever-sdk-generation';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {qleverSdkSourceAdmissionView} from './qlever-sdk-source';
import {derivedSourceView} from './source-context';
import limits from '../module-artifact-limits.json';

/** Mechanical source-read inventory only. This module never issues a legal,
 * source, license, or release capability: every result is an observation of
 * already digitised bytes plus explicit pending reasons. */
const SHA = /^[a-f0-9]{64}$/u;
const safe = (name: unknown): name is string => typeof name === 'string' && name.length > 0
  && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name)
  && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const absolute = (name: unknown): name is string => typeof name === 'string' && name.startsWith('/')
  && !/[\\\u0000-\u001f\u007f]/u.test(name) && safe(name.slice(1));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('SDK generated input contributions: ' + reason); }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
export type SdkInputContribution = Readonly<{path: string; bytes: number; sha256: string; mode: number; captures: number}>;
export type SdkDebianSourceInput = Readonly<{
  installedPath: string; observedPath: string; bytes: number; sha256: string; mode: number;
  binary: Readonly<{name: string; version: string; architecture: string}>;
  source: Readonly<{name: string; version: string}>;
}>;
export type SdkInputContributionResult = Readonly<{
  exactOutput: Readonly<{path: string; bytes: number; sha256: string}>;
  debianSourceInputs: readonly SdkDebianSourceInput[];
  postpatchSourceReads: readonly SdkInputContribution[];
  dependencySourceReads: readonly SdkInputContribution[];
  pending: readonly string[];
  scope: 'conservative complete-phase source-read inventory; no legal or source authority';
}>;

/** Pure join of retained output identity, execution source reads, and the same
 * source's postpatch rows. Caller getters are never consulted. */
export function inspectSdkGeneratedInputContributions(input: {
  output: Readonly<{path: unknown; bytes: unknown; sha256: unknown}>;
  execution: unknown;
  postpatch: unknown;
  binaryFiles?: unknown;
  check?:()=>void;
}): SdkInputContributionResult {
  const check=input.check??(()=>{});check();
  const pending: string[] = [];
  const {output, execution} = input;
  need(output && typeof output === 'object', 'actual generated output required');
  need(absolute(output.path) && integer(output.bytes) && typeof output.sha256 === 'string' && SHA.test(output.sha256), 'actual generated output path/bytes/sha256 required');
  const exactOutput = Object.freeze({path: output.path, bytes: output.bytes, sha256: output.sha256});
  need(execution && typeof execution === 'object', 'existing execution observation required');
  const observed = execution as Record<string, any>;
  need(Array.isArray(observed.outputs) && observed.outputs.length<=limits.sourceMembers, 'actual generated outputs required');
  const matches = observed.outputs.filter((row: any) => row && row.path === exactOutput.path && row.bytes === exactOutput.bytes && row.sha256 === exactOutput.sha256);
  need(matches.length === 1, 'exact generated output path/bytes/sha256 must match one execution output');
  const matched = matches[0];
  need(absolute(matched.path) && integer(matched.bytes) && typeof matched.sha256 === 'string' && SHA.test(matched.sha256), 'execution output identity malformed');
  const postpatchRows = input.postpatch;
  need(Array.isArray(postpatchRows) && postpatchRows.length<=limits.sourceMembers, 'postpatch source read captures required');
  const matchedCount = observed.postpatchSourceReadSnapshotsMatched;
  need(integer(matchedCount) && matchedCount === postpatchRows.length, 'complete postpatch source capture count required');
  need(Array.isArray(observed.dependencySourceReadCaptures) && observed.dependencySourceReadCaptures.length<=limits.sourceMembers, 'dependency source read captures required');
  need(Array.isArray(observed.unresolvedSourceReadPaths), 'unresolved source paths required');
  need(Array.isArray(observed.toolchainFileSnapshots) && observed.toolchainFileSnapshots.length <= limits.sourceMembers, 'toolchain snapshot inventory required');
  const postpatch = new Map<string, SdkInputContribution>();
  for (const row of postpatchRows) {
    check();
    need(row && typeof row === 'object', 'postpatch source row required');
    need(absolute(row.path) && row.path.startsWith('/opt/qlever-sdk/source/') && integer(row.bytes) && typeof row.sha256 === 'string' && SHA.test(row.sha256), 'canonical postpatch source path/bytes/sha256 required');
    need(integer(row.mode) && row.mode <= 0o7777 && positive(row.captures), 'postpatch source mode/capture count required');
    const previous = postpatch.get(row.path);
    if (previous) {
      need(previous.bytes === row.bytes && previous.sha256 === row.sha256 && previous.mode === row.mode && previous.captures === row.captures, 'postpatch source duplicate conflict');
      continue;
    }
    need(postpatch.size < limits.sourceMembers, 'postpatch source capture count bound');
    postpatch.set(row.path, Object.freeze({path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode, captures: row.captures}));
  }
  const dependency = new Map<string, SdkInputContribution>();
  for (const row of observed.dependencySourceReadCaptures) {
    check();
    need(row && typeof row === 'object', 'dependency source row required');
    need(absolute(row.path) && row.path.startsWith('/opt/qlever-sdk/dependencies/'), 'canonical dependency source root required');
    need(integer(row.bytes) && typeof row.sha256 === 'string' && SHA.test(row.sha256) && integer(row.mode) && row.mode <= 0o7777 && positive(row.captures), 'dependency source bytes/sha256/mode/captures required');
    const previous = dependency.get(row.path);
    if (previous) {
      need(previous.bytes === row.bytes && previous.sha256 === row.sha256 && previous.mode === row.mode && previous.captures === row.captures, 'dependency source duplicate conflict');
      continue;
    }
    need(dependency.size < limits.sourceMembers, 'dependency source capture count bound');
    dependency.set(row.path, Object.freeze({path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode, captures: row.captures}));
  }
  const captures = [...postpatch.values(), ...dependency.values()].reduce((total, row) => total + row.captures, 0);
  need(Number.isSafeInteger(captures) && captures === observed.observedSourceReadCaptures, 'postpatch/dependency captures must equal complete observed source read count');
  for (const path of observed.unresolvedSourceReadPaths) need(typeof path === 'string', 'unresolved source path malformed');
  if (observed.unresolvedSourceReadPaths.length) pending.push('qlever-sdk-unresolved-source-read-paths-unclassified');
  if (!postpatch.size && !dependency.size) pending.push('qlever-sdk-complete-phase-source-read-inventory-empty');
  const binaryFiles = input.binaryFiles ?? [];
  need(Array.isArray(binaryFiles) && binaryFiles.length <= limits.sourceMembers, 'signed Debian binary inventory required');
  const installed = new Map<string, any>();
  for (const row of binaryFiles) {
    check();
    need(row && typeof row === 'object', 'signed Debian binary row required');
    const file = row as Record<string, any>;
    need(typeof file.installedPath === 'string' && absolute(file.installedPath) && !installed.has(file.installedPath), 'unique canonical installed Debian path required');
    need(integer(file.bytes) && typeof file.sha256 === 'string' && SHA.test(file.sha256) && integer(file.mode) && file.mode <= 0o7777, 'signed Debian binary bytes/sha256/mode required');
    need(file.source && typeof file.source === 'object' && typeof file.source.name === 'string' && file.source.name.length > 0 && typeof file.source.version === 'string' && file.source.version.length > 0, 'signed Debian actual source coordinate required');
    need(file.binary && typeof file.binary === 'object' && typeof file.binary.name === 'string' && typeof file.binary.version === 'string' && typeof file.binary.architecture === 'string', 'signed Debian binary coordinate required');
    installed.set(file.installedPath, file);
  }
  const debian = new Map<string, SdkDebianSourceInput>();
  for (const row of observed.toolchainFileSnapshots as any[]) {
    check();
    need(row && typeof row === 'object' && typeof row.observedPath === 'string' && absolute(row.observedPath), 'actual toolchain snapshot observed path required');
    need(Array.isArray(row.identity) && row.identity.length === 6 && integer(row.identity[2]) && row.identity[2] <= Number.MAX_SAFE_INTEGER, 'actual toolchain snapshot identity required');
    need(row.original && typeof row.original === 'object' && integer(row.original.bytes) && typeof row.original.sha256 === 'string' && SHA.test(row.original.sha256), 'actual toolchain snapshot original required');
    const mode = row.identity[2] & 0o7777;
    const exact = installed.get(row.observedPath);
    if (!exact) {
      pending.push('qlever-sdk-toolchain-snapshot-unmapped:' + row.observedPath + ':' + row.original.sha256);
      continue;
    }
    need(exact.bytes === row.original.bytes && exact.sha256 === row.original.sha256 && exact.mode === mode, 'actual toolchain snapshot differs from signed official installed file');
    const value: SdkDebianSourceInput = Object.freeze({
      installedPath: exact.installedPath as string, observedPath: row.observedPath, bytes: row.original.bytes as number,
      sha256: row.original.sha256 as string, mode, binary: Object.freeze({name: exact.binary.name as string, version: exact.binary.version as string, architecture: exact.binary.architecture as string}),
      source: Object.freeze({name: exact.source.name as string, version: exact.source.version as string}),
    });
    const key = JSON.stringify(value);
    const previous = debian.get(key);
    if (previous) continue;
    need(debian.size < limits.sourceMembers, 'signed Debian source input bound');
    debian.set(key, value);
  }
  return immutable({
    exactOutput,
    debianSourceInputs: Object.freeze([...debian.values()].sort((left, right) => left.observedPath.localeCompare(right.observedPath))),
    postpatchSourceReads: Object.freeze([...postpatch.values()].sort((left, right) => left.path.localeCompare(right.path))),
    dependencySourceReads: Object.freeze([...dependency.values()].sort((left, right) => left.path.localeCompare(right.path))),
    pending: Object.freeze([...new Set(pending)]),
    scope: 'conservative complete-phase source-read inventory; no legal or source authority',
  });
}

export type SdkContributionBudget = Readonly<{check(): void; remainingMs(): number; reserveBytes(bytes: number): void; chargeReadBytes(bytes: number): void}>;

/** Same private SDK admission and execution handles only; a caller getter
 * object cannot stand in for any of them. */
export function candidateServiceSdkInputContributions(input: {
  sdkOriginals: unknown; sdkAdmission: unknown; source: unknown;
  output: Readonly<{path: string; bytes: number; sha256: string}>; budget: SdkContributionBudget;
}): SdkInputContributionResult & Readonly<{assertCurrent():void}> {
  const budget = input.budget;
  need(budget && typeof budget.check === 'function' && typeof budget.remainingMs === 'function', 'shared budget required');
  budget.check(); need(budget.remainingMs() > 0, 'shared deadline expired');
  const sdk = qleverSdkOriginalsView(input.sdkOriginals);
  need(sdk, 'same actual SDK originals required');
  const source = derivedSourceView(input.source);
  need(source, 'same actual source required');
  const admission = qleverSdkSourceAdmissionView(input.sdkAdmission, {sdkOriginals: input.sdkOriginals, source: input.source});
  need(admission, 'actual private SDK source admission required');
  const execution = qleverSdkExecutionOriginalObservation(input.sdkOriginals);
  need(execution, 'same actual SDK execution observation required');
  const postpatch = qleverSdkPostpatchSourceReadCaptures(input.sdkOriginals);
  need(postpatch, 'same actual postpatch source read captures required');
  const binary = qleverSdkDebianBinaryObservation(input.sdkOriginals);
  need(binary, 'same actual signed Debian binary observation required');
  const observed = execution.sdkGeneratedInputOriginals as Record<string, unknown> | undefined;
  need(observed && typeof observed === 'object', 'actual generated input originals required');
  const current = () => {
    budget.check(); need(budget.remainingMs() > 0, 'shared deadline expired');
    need(qleverSdkOriginalsView(input.sdkOriginals) === sdk
      && derivedSourceView(input.source) === source
      && qleverSdkSourceAdmissionView(input.sdkAdmission, {sdkOriginals: input.sdkOriginals, source: input.source}) === admission
      && qleverSdkExecutionOriginalObservation(input.sdkOriginals) === execution
      && qleverSdkPostpatchSourceReadCaptures(input.sdkOriginals) === postpatch
      && qleverSdkDebianBinaryObservation(input.sdkOriginals) === binary, 'same original observation handles changed');
    binary.assertCurrent();
    budget.check();
  };
  current();
  const result = inspectSdkGeneratedInputContributions({output: input.output, execution: observed, postpatch, binaryFiles: binary.files,check:()=>{budget.check();need(budget.remainingMs()>0,'shared deadline expired');}});
  current();
  return Object.freeze({...result,assertCurrent:current});
}
