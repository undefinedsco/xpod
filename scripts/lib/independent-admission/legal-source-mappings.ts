import path from 'node:path';
import { inspectTypeScriptHelperGrants } from './legal-typescript-helpers';
import { createHash } from 'node:crypto';
import { moduleSourceMaterialView } from './module-source-admission';
import type { CollectedArtifactView, DerivedSourceView } from './artifact-contract';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const notice = (name: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(name));
const license = (name: string) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(path.posix.basename(name));
/** Source scope is inherited only through source worker's private, actually
 * observed compiler input/output bindings. Compiler helper terms remain a
 * separate third-party scope; the entire dev input universe is never shipped. */
export function inspectTranspiledLegalMappings(artifact: CollectedArtifactView, source: DerivedSourceView, capability: unknown,
  verifyGrant: (bytes: Buffer) => boolean, originals: readonly unknown[] = [], verifyApache: (bytes: Buffer, declaredLicense: unknown) => boolean = () => false, declarations: (bytes: Buffer) => string[] = () => []): { sourceScopedOutputs: string[]; coveredOutputs: string[]; compilerOriginals: string[]; pending: string[] } {
  const material = moduleSourceMaterialView(capability), pending: string[] = [], sourceScopedOutputs: string[] = [], coveredOutputs: string[] = [];
  if (!material) return { sourceScopedOutputs, coveredOutputs, compilerOriginals: [], pending };
  if (material.sourceSha !== artifact.identity.sourceSha || material.sourceSha !== source.sourceSha) throw Error('Legal source mappings: source identity differs');
  const actual = new Map(artifact.members.map(row => [row.path, row]));
  if (material.outputs.length !== actual.size || material.outputs.some(row => {
    const member = actual.get(row.path); return !member || member.sha256 !== row.sha256 || member.bytes !== row.bytes;
  })) throw Error('Legal source mappings: actual output inventory differs');
  const sourceQualified = new Set<string>();
  for (const mapping of material.transpiledOutputs) {
    const before = pending.length;
    if (!source.trackedPaths.includes(mapping.sourcePath) || !actual.has(mapping.path)) throw Error('Legal source mappings: original source/output absent');
    let directory = path.posix.dirname(mapping.sourcePath), grants: string[] = [];
    for (;;) {
      const notices = source.trackedPaths.filter(file => path.posix.dirname(file) === directory && notice(file));
      if (!grants.length) grants = notices.filter(license);
      for (const filename of notices) {
        const original = source.readTracked(filename), digest = hash(original);
        if (!artifact.members.some(row => row.sha256 === digest && row.bytes === original.length)) pending.push('Applicable source notice is not retained: ' + filename);
      }
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
    if (!grants.length || grants.some(filename => !verifyGrant(source.readTracked(filename)))) pending.push('Unverified original source grant: ' + mapping.sourcePath);
    else sourceScopedOutputs.push(mapping.path);
    for (const conflict of declarations(source.readTracked(mapping.sourcePath))) pending.push(mapping.sourcePath + ': ' + conflict);
    if (pending.length === before) sourceQualified.add(mapping.path);
  }
  const helpers = inspectTypeScriptHelperGrants(artifact, source, capability, originals, verifyApache);
  pending.push(...helpers.pending);
  for (const mapping of material.transpiledOutputs) {
    if (!helpers.coveredOutputs.includes(mapping.path)) pending.push('Compiler-generated helper scope requires original compiler grant coverage: ' + mapping.path);
    else if (sourceQualified.has(mapping.path)) coveredOutputs.push(mapping.path);
  }
  return { sourceScopedOutputs, coveredOutputs, compilerOriginals: helpers.coveredCompilerOriginals ?? [], pending: [...new Set(pending)] };
}
