import path from 'node:path';
import {createHash} from 'node:crypto';
import limits from '../module-artifact-limits.json';
import {candidateServiceSdkInputContributions} from './candidate-service-sdk-input-contributions';
import {qleverSdkUpstreamSelectedOriginalsView} from './qlever-sdk-upstream-source';
import {inspectTranspiledLegalMappingView} from './legal-source-mappings';
import {derivedSourceView} from './source-context';
import type {CollectedArtifactView} from './artifact-contract';

/** Mechanical applicability over already-observed SDK source reads. This is an
 * adapter, never a capability issuer: it only returns conservative pending
 * reasons or a source-scoped mapping for existing normative callbacks. */
const SHA = /^[a-f0-9]{64}$/u;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SOURCE_ROOT = '/opt/qlever-sdk/source/';
const notice = (name: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(name));
function need(value: unknown, reason: string): asserts value {if (!value) throw Error('SDK Git input applicability: ' + reason);}
function immutable<T>(value: T): T {if (value && typeof value === 'object') {Object.values(value).forEach(immutable); Object.freeze(value);} return value;}
function safeRelative(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name)
    && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export type SdkGitSelection = Readonly<{
  kind: 'generated-source-reads' | 'source-file';
  sourcePaths: readonly string[];
  noticePaths: readonly string[];
  path: string | undefined;
}>;

/** Pure canonical selection: the actual selected file (if a source path) plus
 * every ancestor LICENSE/COPYING/NOTICE/COPYRIGHT in the complete postpatch
 * universe. Never selects by hash or by filename guessing beyond ancestors. */
export function selectSdkGitSourcePaths(input: {
  memberPath: string | undefined;
  postpatchPaths: readonly string[];
  generatedPostpatchPaths?: readonly string[];
  check?:()=>void;
}): SdkGitSelection {
  const check=input.check??(()=>{});check();need(input.postpatchPaths.length<=limits.sourceMembers&&(input.generatedPostpatchPaths?.length??0)<=limits.sourceMembers,'bounded source inventory required');
  const byDirectory=new Map<string,string[]>();
  const universe = new Set<string>();
  for (const name of input.postpatchPaths) {check();need(safeRelative(name), 'canonical postpatch path required'); need(!universe.has(name), 'unique postpatch path required'); universe.add(name);if(notice(name)){const parent=path.posix.dirname(name);byDirectory.set(parent,[...(byDirectory.get(parent)??[]),name]);}}
  need(universe.size <= limits.sourceMembers, 'postpatch path bound');
  const relative=typeof input.memberPath==='string'&&input.memberPath.startsWith(SOURCE_ROOT)?input.memberPath.slice(SOURCE_ROOT.length):undefined;
  const direct=relative&&safeRelative(relative)&&universe.has(relative)?relative:undefined;
  // Only an actual postpatch member can be a direct source; an artifact path
  // such as /out/tool is never mapped into the Git source universe.
  const directSource = direct && universe.has(direct) ? [direct] : [];
  const notices = new Set<string>();
  for (const sourcePath of input.generatedPostpatchPaths ?? (directSource.length ? directSource : [])) {
    check();need(safeRelative(sourcePath) && universe.has(sourcePath), 'generated selected source absent from complete postpatch universe');
    let directory = path.posix.dirname(sourcePath);
    for (;;) {
      check();for (const candidate of byDirectory.get(directory)??[]) notices.add(candidate);
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  const sourcePaths = [...new Set([...(input.generatedPostpatchPaths ?? []), ...directSource])].sort();
  return Object.freeze({kind: input.generatedPostpatchPaths?.length ? 'generated-source-reads' : 'source-file', sourcePaths: Object.freeze(sourcePaths),
    noticePaths: Object.freeze([...notices].sort()), path: input.generatedPostpatchPaths?.length ? undefined : direct});
}

type Budget = Readonly<{check(): void; remainingMs(): number; remainingReadBytes(): number; reserveBytes(bytes: number): void; chargeReadBytes(bytes: number): void}>;

/** Actual async adapter over the same verified upstream private view and the
 * existing SDK generated-input projection. No grant is issued here. */
export type SdkGitPreparedApplicability = Readonly<{
  memberPath: string;
  /** Authenticated signed-Debian contributors for this generated output.
   * Empty for non-Debian outputs or outputs with no Debian contributors. */
  debianSourceInputs: readonly Readonly<Record<string, unknown>>[];
  inspect(verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[]): Readonly<{covered: boolean; pending: readonly string[]; mappings: readonly Readonly<{path: string; sourcePath: string}>[]; debianSourceInputs: readonly Readonly<Record<string, unknown>>[]}>;
  assertCurrent(): void;
}>;

/** Actual async preparation over the same verified upstream private view and
 * the existing SDK generated-input projection. Parser callbacks stay in
 * inspect(); this never issues a grant. */
export async function prepareSdkGitInputApplicability(input: {
  sdkOriginals: unknown; source: unknown; sdkAdmission: unknown;
  input: Readonly<{path: string; bytes: number; sha256: string; mode: number}>;
  artifact: CollectedArtifactView; memberPath: string; sourceSha: string; budget: Budget;
}): Promise<SdkGitPreparedApplicability> {
  const {sdkOriginals, source, budget} = input;
  const check = () => {budget.check(); need(budget.remainingMs() > 0, 'shared deadline exhausted');};
  check();
  const upstream = qleverSdkUpstreamSelectedOriginalsView(sdkOriginals, source, input.sdkAdmission);
  need(upstream, 'same verified upstream selected-source view required');
  upstream.assertCurrent(); check();
  const immutableSource=derivedSourceView(source);need(immutableSource&&immutableSource.sourceSha===input.sourceSha,'same private immutable source required');
  const members = new Map(upstream.postpatchMembers.map(row => [row.path, row]));
  need(members.size === upstream.postpatchMembers.length, 'unique complete postpatch members required');
  need(typeof input.memberPath === 'string' && input.memberPath.length > 0, 'actual artifact member path required');
  need(input.sourceSha === input.artifact.identity.sourceSha, 'artifact/source identity differs');
  const pending: string[] = [];
  let contributingSources: string[] = [];
  const direct = input.input.path.startsWith(SOURCE_ROOT) ? input.input.path.slice(SOURCE_ROOT.length) : undefined;
  const exact = direct ? members.get(direct) : undefined;
  let generatedGuard: (() => void) | undefined;
  const preparedDebian: any[] = [];
  if (exact) {
    need(Number.isSafeInteger(input.input.bytes) && Number.isSafeInteger(input.input.mode) && typeof input.input.sha256 === 'string' && SHA.test(input.input.sha256)
      && exact.bytes === input.input.bytes && exact.sha256 === input.input.sha256 && exact.mode === input.input.mode, 'actual SDK source input differs from complete postpatch member');
    contributingSources = [direct!];
  } else {
    const generated = candidateServiceSdkInputContributions({sdkOriginals, sdkAdmission: input.sdkAdmission, source,
      output: {path: input.input.path, bytes: input.input.bytes, sha256: input.input.sha256}, budget});
    generatedGuard = generated.assertCurrent;
    pending.push(...generated.pending);
    // Each contributor class is composed into this same projection by the
    // normal legal adapter. Only genuinely uncomposed scopes remain pending.
    if (!generated.dependencySourceReads.length && !generated.debianSourceInputs.length && !generated.postpatchSourceReads.length)
      pending.push('SDK generated output has no complete postpatch source read inventory: ' + input.memberPath);
    // Signed Debian contributors require the existing package archive path; they
    // are not silently treated as satisfied by source-read bytes alone.
    if (generated.debianSourceInputs.length) preparedDebian.push(...generated.debianSourceInputs);
    contributingSources = generated.postpatchSourceReads.map(row=>{const name=row.path.startsWith(SOURCE_ROOT)?row.path.slice(SOURCE_ROOT.length):'';const original=members.get(name);need(original&&original.bytes===row.bytes&&original.sha256===row.sha256&&original.mode===row.mode,'actual contributing SDK read differs from postpatch member');return name;});
    need(contributingSources.every(name => safeRelative(name) && members.has(name)), 'complete postpatch source read absent from selected upstream view');
  }
  const selection = selectSdkGitSourcePaths({memberPath: input.input.path, postpatchPaths: [...members.keys()], generatedPostpatchPaths: contributingSources,check});
  need(selection.sourcePaths.every(name => members.has(name)), 'selected source absent from captured postpatch members');
  // Deterministic batches bounded by projected base64 + JSON metadata; the
  // shared parent budget is never reset between batches.
  const allSelected = [...new Set([...selection.sourcePaths, ...selection.noticePaths])].sort();
  for (const name of allSelected) {const row = members.get(name)!; need(4 * Math.ceil(row.bytes / 3) + name.length + 256 <= limits.metadataBytes, 'single selected source exceeds metadata response bound');}
  const read=new Map<string,Buffer>();
  const planned: string[][] = []; let current: string[] = []; let size = 4096;
  for (const name of allSelected) {
    const row = members.get(name)!; const estimate = 4 * Math.ceil(row.bytes / 3) + name.length + 256;
    if (size + estimate > limits.metadataBytes && current.length) {planned.push(current); current = []; size = 4096;}
    current.push(name); size += estimate;
  }
  if (current.length) planned.push(current);
  for (const names of planned) {
    check();
    const observed = await upstream.readSelectedOriginals(names, {check: budget.check, remainingMs: () => budget.remainingMs(),
      remainingReadBytes: () => budget.remainingReadBytes(), reserveBytes: bytes => budget.reserveBytes(bytes), chargeReadBytes: bytes => budget.chargeReadBytes(bytes)});
    observed.assertCurrent(); check();
    for (const name of names) {
      const expected = members.get(name)!; const bytes = observed.readTracked(name); check();
      need(bytes.length === expected.bytes && sha256(bytes) === expected.sha256, 'selected actual source bytes differ from captured postpatch member');
      need(!read.has(name), 'duplicate selected source response');
      read.set(name, bytes);
    }
  }
  need(allSelected.every(name => read.has(name)), 'complete selected source read required');
  const trackedPaths = [...members.keys()].sort();
  const mappings = selection.sourcePaths.map(name => ({path: input.memberPath, sourcePath: name}));
  // Private inventory never escapes; each consumer receives a charged copy.
  const heldRead = read;
  const assertCurrent = () => {
    check(); upstream.assertCurrent();
    need(derivedSourceView(source) === immutableSource, 'same immutable source reached selected result');
    need(qleverSdkUpstreamSelectedOriginalsView(sdkOriginals, source, input.sdkAdmission) !== undefined, 'same verified upstream selected view required');
    generatedGuard?.();
    check();
  };
  assertCurrent();
  const inspect = (verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[]) => {
    assertCurrent();
    const observed = inspectTranspiledLegalMappingView({
      material: {sourceSha: input.sourceSha, outputs: input.artifact.members, transpiledOutputs: mappings},
      artifactSourceSha: input.artifact.identity.sourceSha, sourceSha: input.sourceSha, trackedPaths,
      readTracked: name => {assertCurrent(); const bytes = heldRead.get(name); need(bytes, 'selected source text not retained: ' + name);
        need(bytes.length <= budget.remainingReadBytes(), 'selected copy exceeds parent read budget'); budget.reserveBytes(bytes.length); budget.chargeReadBytes(bytes.length); return Buffer.from(bytes);},
      artifactMembers: input.artifact.members, check: assertCurrent}, verifyGrant, declarations);
    assertCurrent();
    const allPending = [...pending, ...observed.pending];
    const covered = allPending.length === 0 && contributingSources.length > 0 && observed.coveredOutputs.includes(input.memberPath)
      && mappings.every(mapping => observed.coveredOutputs.includes(mapping.path));
    return immutable({covered, pending: Object.freeze([...new Set(allPending)]),
      mappings: Object.freeze(mappings.map(row => Object.freeze({...row}))),
      // Genuine immutable contributors, never dropped before the legal seam.
      debianSourceInputs: Object.freeze(preparedDebian.map(row => Object.freeze({...row})))});
  };
  return immutable({memberPath: input.memberPath,
    debianSourceInputs: Object.freeze(preparedDebian.map(row => Object.freeze({...row}))),
    inspect, assertCurrent});
}

/** Existing observation API delegates: one parser, no duplicate policy. */
export async function observeSdkGitInputApplicability(input: Parameters<typeof prepareSdkGitInputApplicability>[0] & {
  verifyGrant(bytes: Buffer): boolean; declarations(bytes: Buffer): string[];
}) {
  const prepared = await prepareSdkGitInputApplicability(input);
  return prepared.inspect(input.verifyGrant, input.declarations);
}
