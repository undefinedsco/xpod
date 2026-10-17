import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import type { CollectedArtifactMember, DerivedSourceView } from './artifact-contract';
import type { AdmissionContext } from './index';

// Reuse the existing SPDX MIT standard-template material, not another license
// catalog. A changed template requires code review rather than candidate policy.
const { MANIFEST_MAX_BYTES } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');
const MIT_TEMPLATE = 'packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt';
const MIT_TEMPLATE_SHA = 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Legal admission: ' + message); };
const safe = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\\')
  && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const notice = (filename: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(filename));
const license = (filename: string) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(path.posix.basename(filename));
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();

/** Exact normative MIT terms plus an actual retained copyright notice. This is
 * a text predicate only, never package ownership or a legal admission token. */
export function verifyMitGrantText(original: Buffer, standardTemplate: Buffer): boolean {
  if (hash(standardTemplate) !== MIT_TEMPLATE_SHA) return false;
  const text = original.toString('utf8').replace(/\r\n/gu, '\n');
  const template = standardTemplate.toString('utf8');
  const marker = 'Permission is hereby granted';
  const offset = text.indexOf(marker), templateOffset = template.indexOf(marker);
  if (offset < 0 || templateOffset < 0 || text.indexOf(marker, offset + marker.length) !== -1) return false;
  const heading = text.slice(0, offset).trim();
  // No invented holders, placeholder-only template copyright, or additional
  // restrictions in the heading. Other grant forms require their own adapter.
  const lines = heading.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] === 'MIT License') lines.shift();
  if (lines.length !== 1 || !/^Copyright\s+(?:\(c\)|©)\s+(?:\[\d{4}\]|\d{4}(?:[-,\s\d]*))\s+\S.+$/iu.test(lines[0]!)
    || /<year>|<copyright holders>|\[year\]|\[fullname\]/iu.test(lines[0]!)) return false;
  return normalize(text.slice(offset)) === normalize(template.slice(templateOffset));
}
/** Only explicit declarations are interpreted. This adapter supports the exact
 * MIT grant, so every other SPDX expression or explicit license override stays
 * pending; it does not guess permissions from ordinary prose/comments. */
export function explicitLicenseConflicts(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  const declarations: string[] = [];
  for (const match of text.matchAll(/SPDX-License-Identifier:[ \t]*([^\r\n]+)/gu)) {
    const expression = match[1]!.replace(/[ \t]*(?:\*\/|-->|#>)[ \t]*$/u, '').trim();
    if (expression !== 'MIT') declarations.push('Explicit SPDX expression requires another grant adapter: ' + expression);
  }
  // Named @license/@licence declarations are explicit overrides, unlike generic
  // references to licenses in explanatory comments. No provider/license catalog.
  for (const match of text.matchAll(/@licen[cs]e[ \t]+([^\r\n]+)/gu)) {
    const declaration = match[1]!.replace(/[ \t]*(?:\*\/|-->)[ \t]*$/u, '').trim();
    if (declaration !== 'MIT') declarations.push('Explicit license declaration requires another grant adapter: ' + declaration);
  }
  for (const match of text.matchAll(/^[ \t]*(?:(?:\/\/|#|\*|<!--)[ \t]*)?(?:Licensed under|License:|Licensing:)[ \t]+([^\r\n]+)/gmu)) {
    const declaration = match[1]!.replace(/[ \t]*(?:\*\/|-->)[ \t]*$/u, '').trim();
    if (!/^(?:the )?MIT(?: License)?\.?$/u.test(declaration)) declarations.push('Explicit license declaration requires another grant adapter: ' + declaration);
  }
  return [...new Set(declarations)];
}
interface Binding { path: string; sourcePath: string; grantSourcePath: string }
interface ExactGrantEvidence { schemaVersion: 1; kind: 'source-exact-license-grants'; files: Binding[] }
export interface LegalAdmissionFacts {
  artifactCustodyVerified: boolean;
  immutableSourceVerified: boolean;
  exactFileCoverageVerified: boolean;
  originalNoticesVerified: boolean;
  normativeGrantVerified: boolean;
  legalQualified: boolean;
}
export interface LegalAdmissionResult {
  status: 'pending' | 'verified'; reason: string; pending: string[]; facts: LegalAdmissionFacts;
  scope: 'mechanical exact-source MIT grant and notice preservation; no external legal opinion or release qualification';
}

/** Pure exact-layout derivation, not an issuer. Generated files deliberately
 * do not acquire a grant by matching unrelated bytes elsewhere in the tree. */
export function deriveExactSourceGrantDeclaration(members: readonly CollectedArtifactMember[], source: Pick<DerivedSourceView, 'trackedPaths' | 'readTracked'>,
  sourcePrefix: string): { evidence?: ExactGrantEvidence; pending: string[] } {
  if (!safe(sourcePrefix) || members.length > 20000) fail('bounded canonical source layout required');
  const tracked = new Set(source.trackedPaths), files: Binding[] = [], pending: string[] = [];
  const nearestGrant = (sourcePath: string) => {
    let directory = path.posix.dirname(sourcePath);
    for (;;) {
      const found = source.trackedPaths.filter(file => license(file) && path.posix.dirname(file) === directory).sort();
      if (found.length) return found[0];
      if (directory === '.') return undefined;
      directory = path.posix.dirname(directory);
    }
  };
  for (const member of members) {
    const local = sourcePrefix + '/' + member.path;
    // Shared repository notices are allowed only at the same notice basename.
    const sourcePath = tracked.has(local) ? local : notice(member.path) && !member.path.includes('/') && tracked.has(member.path) ? member.path : undefined;
    if (!sourcePath || member.bytes > 4 * 1024 ** 2) { pending.push('No bounded exact canonical source mapping: ' + member.path); continue; }
    const bytes = source.readTracked(sourcePath);
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) { pending.push('Generated or changed archive member requires provenance grant adapter: ' + member.path); continue; }
    const grantSourcePath = nearestGrant(sourcePath);
    if (!grantSourcePath) { pending.push('Original scoped grant missing: ' + sourcePath); continue; }
    files.push({ path: member.path, sourcePath, grantSourcePath });
  }
  return pending.length ? { pending } : { pending: [], evidence: { schemaVersion: 1, kind: 'source-exact-license-grants', files } };
}

/** First adapter's declaration surface: every archive file is an exact tracked
 * source file, applicable nearest ancestor LICENSE/COPYING files are genuine
 * MIT grants, and every applicable original notice is shipped byte-for-byte.
 * Bundles/generated/third-party supplemental provenance need a separate reviewed
 * adapter or real external-original capability; JSON URLs/hashes are not issuers.
 */
export function verifyLegalAdmission(evidence: unknown, context: Pick<AdmissionContext, 'collectedArtifact' | 'derivedSource' | 'package' | 'version' | 'sourceSha' | 'target'>): LegalAdmissionResult {
  const artifact = collectedArtifactView(context.collectedArtifact), source = derivedSourceView(context.derivedSource);
  const facts: LegalAdmissionFacts = { artifactCustodyVerified: Boolean(artifact), immutableSourceVerified: Boolean(source),
    exactFileCoverageVerified: false, originalNoticesVerified: false, normativeGrantVerified: false, legalQualified: false };
  const pending: string[] = [];
  const result = (): LegalAdmissionResult => ({ status: facts.legalQualified ? 'verified' : 'pending',
    reason: pending.join('; ') || 'Exact source grant and retained original notices verified', pending: [...new Set(pending)], facts,
    scope: 'mechanical exact-source MIT grant and notice preservation; no external legal opinion or release qualification' });
  if (!artifact || !source) { pending.push('Real collected artifact and immutable Git source capabilities required'); return result(); }
  if (artifact.identity.package !== context.package || artifact.identity.version !== context.version
    || artifact.identity.sourceSha !== context.sourceSha || source.sourceSha !== context.sourceSha
    || artifact.identity.target !== context.target) fail('artifact/source/context identity mismatch');
  const manifest = JSON.parse(artifact.readMember('package.json', MANIFEST_MAX_BYTES).toString());
  if (manifest.name !== context.package || manifest.version !== context.version) fail('actual package manifest identity mismatch');
  // Read the real packed inventories as diagnostics, never as approval. This
  // includes missing originals such as global-logger-factory; no exception list.
  for (const member of artifact.members.filter(row => /(?:^|\/)(?:licenses|notices|terms)\/.*index\.json$/u.test(row.path)).slice(0, 64)) {
    const index = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
    for (const item of [...(Array.isArray(index.packages) ? index.packages : []), ...(Array.isArray(index.entries) ? index.entries : [])]) {
      if (!item || typeof item !== 'object') continue;
      if (item.noticeStatus === 'missing-original' || (Array.isArray(item.originals) && !item.originals.length && !item.supplements?.length)) pending.push(`Original terms missing: ${item.name}@${item.version}`);
    }
    for (const item of Array.isArray(index.missingNamedOriginalTerms) ? index.missingNamedOriginalTerms : []) pending.push(`Original terms missing: ${item.name}@${item.version}`);
  }
  let declaration = evidence as ExactGrantEvidence | null;
  if (evidence === undefined) {
    const module = manifest.xpodModule?.id;
    const leaf = typeof module === 'string' && ['api', 'css', 'afs'].includes(module) ? 'xpod-' + module : context.package.split('/').pop();
    if (!leaf || !/^xpod-(?:client|cli|api|css|afs)$/u.test(leaf)) { pending.push('Unregistered exact source layout'); return result(); }
    const derived = deriveExactSourceGrantDeclaration(artifact.members, source, 'packages/' + leaf);
    if (!derived.evidence) { pending.push(...derived.pending); return result(); }
    declaration = derived.evidence;
  }
  if (declaration?.schemaVersion !== 1 || declaration.kind !== 'source-exact-license-grants' || !Array.isArray(declaration.files)) {
    pending.push('No reviewed complete grant adapter for this bundled/generated or supplemental evidence format'); return result();
  }
  const tracked = new Set(source.trackedPaths), bindings = new Map<string, Binding>(), mappedSources = new Set<string>();
  if (declaration.files.length > 20000) fail('grant coverage budget exceeded');
  for (const binding of declaration.files) {
    if (!binding || !safe(binding.path) || !safe(binding.sourcePath) || !safe(binding.grantSourcePath) || bindings.has(binding.path)) fail('unsafe or duplicate source/grant binding');
    if (!tracked.has(binding.sourcePath) || !tracked.has(binding.grantSourcePath)) fail('source/grant absent from immutable Git');
    bindings.set(binding.path, binding); mappedSources.add(binding.sourcePath);
  }
  if (bindings.size !== artifact.members.length || artifact.members.some(member => !bindings.has(member.path))) { pending.push('Every actual archive member requires exact source and grant coverage'); return result(); }
  for (const member of artifact.members) {
    const binding = bindings.get(member.path)!;
    const bytes = source.readTracked(binding.sourcePath);
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256 || !bytes.equals(artifact.readMember(member.path, 8 * 1024 ** 2))) fail('archive file differs from declared exact source');
    for (const conflict of explicitLicenseConflicts(bytes)) pending.push(binding.sourcePath + ': ' + conflict);
  }
  facts.exactFileCoverageVerified = true;
  if (!tracked.has(MIT_TEMPLATE)) { pending.push('Reviewed standard grant template absent from immutable source'); return result(); }
  const template = source.readTracked(MIT_TEMPLATE);
  if (hash(template) !== MIT_TEMPLATE_SHA) fail('reviewed grant template changed');
  for (const binding of bindings.values()) {
    const ancestors: string[] = []; let current = path.posix.dirname(binding.sourcePath);
    for (;;) { ancestors.push(current === '.' ? '' : current); if (current === '.') break; current = path.posix.dirname(current); }
    const applicable = source.trackedPaths.filter(file => notice(file) && ancestors.includes(path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)));
    const grants = applicable.filter(license);
    const nearestDirectory = ancestors.find(directory => grants.some(file => (path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)) === directory));
    const nearest = grants.filter(file => (path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)) === nearestDirectory);
    if (!nearest.includes(binding.grantSourcePath)) pending.push('Grant does not establish nearest source scope: ' + binding.sourcePath);
    for (const file of applicable) if (!mappedSources.has(file)) pending.push('Applicable original notice is not retained: ' + file);
    for (const file of nearest) if (!verifyMitGrantText(source.readTracked(file), template)) pending.push('Unverified custom/unknown grant or missing genuine copyright: ' + file);
  }
  facts.originalNoticesVerified = !pending.some(message => /notice|terms missing/iu.test(message));
  facts.normativeGrantVerified = !pending.some(message => /grant|copyright|license declaration|SPDX expression/iu.test(message));
  facts.legalQualified = pending.length === 0;
  return result();
}
