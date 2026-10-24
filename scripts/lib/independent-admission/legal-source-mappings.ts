import path from 'node:path';
import { inspectTypeScriptHelperGrants } from './legal-typescript-helpers';
import { createHash } from 'node:crypto';
import { moduleSourceMaterialView } from './module-source-admission';
import type { CollectedArtifactView, DerivedSourceView } from './artifact-contract';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const notice = (name: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(name));
const license = (name: string) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(path.posix.basename(name));
/** Structural/pure reader contract for transpiled-output mapping. The caller
 * supplies already-validated material semantics plus actual artifact/source
 * readers; this module issues no capability and normalizes no path. Absolute
 * /app or /opt/xpod/qlever output keys are matched verbatim. */
export interface TranspiledLegalMappingViewInput {
  readonly material: {
    readonly sourceSha: string;
    readonly outputs: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
    readonly transpiledOutputs: readonly { readonly path: string; readonly sourcePath: string }[];
  };
  readonly artifactSourceSha: string;
  readonly sourceSha: string;
  readonly trackedPaths: readonly string[];
  readTracked(path: string): Buffer;
  readonly artifactMembers: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
  readonly check?: () => void;
}
export interface TranspiledLegalMappingViewResult { sourceScopedOutputs: string[]; coveredOutputs: string[]; compilerOriginals: string[]; pending: string[] }

/** Pure source-scope evaluation: every output maps to a tracked Git source,
 * applicable ancestor license texts verify, explicit declarations are
 * audited, and applicable source notices are retained in the artifact. */
export function inspectTranspiledLegalMappingView(input: TranspiledLegalMappingViewInput,
  verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[] = () => []): TranspiledLegalMappingViewResult {
  const { material } = input;
  const pending: string[] = [], sourceScopedOutputs: string[] = [];
  if (material.sourceSha !== input.artifactSourceSha || material.sourceSha !== input.sourceSha) throw Error('Legal source mappings: source identity differs');
  const actual = new Map(input.artifactMembers.map(row => [row.path, row]));
  if (material.outputs.length !== actual.size || material.outputs.some(row => {
    const member = actual.get(row.path); return !member || member.sha256 !== row.sha256 || member.bytes !== row.bytes;
  })) throw Error('Legal source mappings: actual output inventory differs');
  const sourceQualified = new Set<string>();
  for (const mapping of material.transpiledOutputs) {
    input.check?.();
    const before = pending.length;
    if (!input.trackedPaths.includes(mapping.sourcePath) || !actual.has(mapping.path)) throw Error('Legal source mappings: original source/output absent');
    let directory = path.posix.dirname(mapping.sourcePath), grants: string[] = [];
    for (;;) {
      const notices = input.trackedPaths.filter(file => path.posix.dirname(file) === directory && notice(file));
      if (!grants.length) grants = notices.filter(license);
      for (const filename of notices) {
        const original = input.readTracked(filename), digest = hash(original);
        if (!input.artifactMembers.some(row => row.sha256 === digest && row.bytes === original.length)) pending.push('Applicable source notice is not retained: ' + filename);
      }
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
    if (!grants.length || grants.some(filename => !verifyGrant(input.readTracked(filename)))) pending.push('Unverified original source grant: ' + mapping.sourcePath);
    else sourceScopedOutputs.push(mapping.path);
    for (const conflict of declarations(input.readTracked(mapping.sourcePath))) pending.push(mapping.sourcePath + ': ' + conflict);
    if (pending.length === before) sourceQualified.add(mapping.path);
  }
  return { sourceScopedOutputs, coveredOutputs: [...sourceQualified], compilerOriginals: [], pending: [...new Set(pending)] };
}

/** Source scope is inherited only through source worker's private, actually
 * observed compiler input/output bindings. Compiler helper terms remain a
 * separate third-party scope; the entire dev input universe is never shipped. */
export function inspectTranspiledLegalMappings(artifact: CollectedArtifactView, source: DerivedSourceView, capability: unknown,
  verifyGrant: (bytes: Buffer) => boolean, originals: readonly unknown[] = [], verifyApache: (bytes: Buffer, declaredLicense: unknown) => boolean = () => false, declarations: (bytes: Buffer) => string[] = () => []): { sourceScopedOutputs: string[]; coveredOutputs: string[]; compilerOriginals: string[]; pending: string[] } {
  const material = moduleSourceMaterialView(capability), pending: string[] = [], sourceScopedOutputs: string[] = [], coveredOutputs: string[] = [];
  if (!material) return { sourceScopedOutputs, coveredOutputs, compilerOriginals: [], pending };
  const view = inspectTranspiledLegalMappingView({ material, artifactSourceSha: artifact.identity.sourceSha, sourceSha: source.sourceSha,
    trackedPaths: source.trackedPaths, readTracked: name => source.readTracked(name), artifactMembers: artifact.members }, verifyGrant, declarations);
  pending.push(...view.pending); sourceScopedOutputs.push(...view.sourceScopedOutputs);
  const helpers = inspectTypeScriptHelperGrants(artifact, source, capability, originals, verifyApache);
  pending.push(...helpers.pending);
  for (const mapping of material.transpiledOutputs) {
    if (!helpers.coveredOutputs.includes(mapping.path)) pending.push('Compiler-generated helper scope requires original compiler grant coverage: ' + mapping.path);
    else if (view.coveredOutputs.includes(mapping.path)) coveredOutputs.push(mapping.path);
  }
  return { sourceScopedOutputs, coveredOutputs, compilerOriginals: helpers.coveredCompilerOriginals ?? [], pending: [...new Set(pending)] };
}
