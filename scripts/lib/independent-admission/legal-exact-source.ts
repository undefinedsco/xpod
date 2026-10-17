import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CollectedArtifactView, DerivedSourceView } from './artifact-contract';
import { isNativeLegalMaterial } from './legal-coverage';
export interface ExactSourceGrantBinding { path: string; sourcePath: string; grantSourcePath: string }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const notice = (name: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(name));
const license = (name: string) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(path.posix.basename(name));
/** Pure scoped grant/retention check. Callbacks establish no custody; the gate
 * exclusively supplies its centrally collected archive and immutable Git view. */
export function inspectExactSourceGrantBinding(binding: ExactSourceGrantBinding, artifact: CollectedArtifactView, source: DerivedSourceView,
  verifyGrant: (bytes: Buffer) => boolean, declarations: (bytes: Buffer) => string[]): string[] {
  const pending: string[] = [], tracked = new Set(source.trackedPaths);
  if (!tracked.has(binding.sourcePath) || !tracked.has(binding.grantSourcePath)) throw Error('Legal exact source: source/grant absent from immutable Git');
  const member = artifact.members.find(row => row.path === binding.path);
  if (!member) throw Error('Legal exact source: binding is not an actual archive member');
  if (member.bytes > 4 * 1024 ** 2) return ['Bounded exact source proof required: ' + binding.path];
  const bytes = source.readTracked(binding.sourcePath);
  if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) throw Error('Legal exact source: archive file differs from declared exact source');
  if (/(?:^|\/)(?:node_modules|provenance|licenses|fixtures)(?:\/|$)/u.test(binding.path)) pending.push('Retained third-party material needs original grant scope: ' + binding.path);
  if (isNativeLegalMaterial(bytes)) pending.push('Native exact source requires native grant scope: ' + binding.path);
  for (const conflict of declarations(bytes)) pending.push(binding.sourcePath + ': ' + conflict);
  const ancestors: string[] = []; let current = path.posix.dirname(binding.sourcePath);
  for (;;) { ancestors.push(current); if (current === '.') break; current = path.posix.dirname(current); }
  const applicable = source.trackedPaths.filter(file => notice(file) && ancestors.includes(path.posix.dirname(file)));
  const grants = applicable.filter(license), nearestDirectory = ancestors.find(directory => grants.some(file => path.posix.dirname(file) === directory));
  const nearest = grants.filter(file => path.posix.dirname(file) === nearestDirectory);
  if (!nearest.includes(binding.grantSourcePath)) pending.push('Grant does not establish nearest source scope: ' + binding.sourcePath);
  for (const filename of applicable) {
    const original = source.readTracked(filename), digest = hash(original);
    if (!artifact.members.some(row => row.sha256 === digest && row.bytes === original.length)) pending.push('Applicable original notice is not retained: ' + filename);
  }
  for (const filename of nearest) if (!verifyGrant(source.readTracked(filename))) pending.push('Unverified custom/unknown grant or missing genuine copyright: ' + filename);
  return pending;
}
