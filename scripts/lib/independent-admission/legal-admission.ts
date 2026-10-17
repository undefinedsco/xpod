import { readLegalProductManifest } from './legal-product-manifest';
import path from 'node:path';
import { inspectExactSourceGrantBinding, type ExactSourceGrantBinding as Binding } from './legal-exact-source';
import { LegalCoverageLedger, type LegalCoverageReport } from './legal-coverage';
import { inspectTranspiledLegalMappings } from './legal-source-mappings';
import { inspectBundleLegalMaterials } from './legal-bundle-materials';
import { inspectPhysicalLegalMaterials } from './legal-material-inventory';
import { createHash } from 'node:crypto';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import type { CollectedArtifactMember, DerivedSourceView } from './artifact-contract';
import type { AdmissionContext } from './index';

// Reuse the existing SPDX MIT standard-template material, not another license
// catalog. A changed template requires code review rather than candidate policy.
const MIT_TEMPLATE = 'packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt';
const ISC_TEMPLATE_SHA = 'b29f8b01452350c20dd1af16ef83b598fea3053578ccc1c7a0ef40e57be2620f';
const ISC_TEMPLATE = 'packages/xpod-cli/licenses/native/collection/objects/' + ISC_TEMPLATE_SHA + '.txt';
const APACHE_TEMPLATE = 'packages/xpod-cli/licenses/native/collection/objects/cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30.txt';
const APACHE_TEMPLATE_SHA = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const MIT_TEMPLATE_SHA = 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never { throw new Error('Legal admission: ' + message); }
const safe = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\\')
  && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const notice = (filename: string) => /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/iu.test(path.posix.basename(filename));
const license = (filename: string) => /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(path.posix.basename(filename));
const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();

function originalCopyrightLines(lines: string[]): boolean {
  return lines.length > 0 && !lines.some(line => {
    if (!/^Copyright\s+/iu.test(line) || /<year>|<copyright holders?>|\[year\]|\[fullname\]|\[copyright holders?\]/iu.test(line)) return true;
    const holder = line.replace(/^Copyright\s+(?:(?:\(c\)|©)\s*)?/iu, '').replace(/^\[?\d{4}\]?[\d\s,–—-]*/u, '').replace(/^\[|\]$/gu, '').trim();
    return !/[\p{L}]/u.test(holder) || /^(?:copyright holders?|fullname|name|year|authors?)\.?$/iu.test(holder);
  });
}

/** Exact normative MIT terms plus an actual retained copyright notice. This is
 * a text predicate only, never package ownership or a legal admission token. */
export function verifyMitGrantText(original: Buffer, standardTemplate: Buffer): boolean {
  if (hash(standardTemplate) !== MIT_TEMPLATE_SHA) return false;
  let text = original.toString('utf8').replace(/\r\n/gu, '\n').trim();
  if (text.endsWith('End license text.Source Distributions')) text = text.slice(0, -'Source Distributions'.length);
  if (text.startsWith('Begin license text.\n') && text.endsWith('\nEnd license text.')) text = text.slice('Begin license text.\n'.length, -'\nEnd license text.'.length).trim();
  const template = standardTemplate.toString('utf8');
  const marker = 'Permission is hereby granted';
  const offset = text.indexOf(marker), templateOffset = template.indexOf(marker);
  if (offset < 0 || templateOffset < 0 || text.indexOf(marker, offset + marker.length) !== -1) return false;
  const heading = text.slice(0, offset).trim();
  // No invented holders, placeholder-only template copyright, or additional
  // restrictions in the heading. Other grant forms require their own adapter.
  const lines = heading.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] === 'MIT License' || lines[0] === 'The MIT License (MIT)') lines.shift();
  if (!originalCopyrightLines(lines)) return false;
  return normalize(text.slice(offset)) === normalize(template.slice(templateOffset));
}
/** Full unchanged ISC grant and an actual original holder, scoped only by an
 * original manifest that declares ISC. No inference from SPDX labels alone. */
export function verifyIscGrantText(original: Buffer, standard: Buffer, declaredLicense: unknown): boolean {
  if (declaredLicense !== 'ISC' || hash(standard) !== ISC_TEMPLATE_SHA) return false;
  const text = original.toString('utf8').replace(/\r\n/gu, '\n').trim();
  const marker = 'Permission to use, copy, modify, and/or distribute this software';
  const offset = text.indexOf(marker), template = standard.toString('utf8');
  if (offset < 0 || text.indexOf(marker, offset + marker.length) !== -1) return false;
  const lines = text.slice(0, offset).split('\n').map(line => line.trim()).filter(Boolean);
  if (lines[0] === 'ISC License' || lines[0] === 'The ISC License') lines.shift();
  return originalCopyrightLines(lines) && normalize(text.slice(offset)) === normalize(template.slice(template.indexOf(marker)));
}
/** The unchanged Apache text alone is a template, not a package grant.
 * Application must additionally come from the registry-original manifest;
 * actual source copyright/NOTICE preservation is checked by the caller. */
export function verifyApacheGrantText(original: Buffer, standard: Buffer, declaredLicense: unknown): boolean {
  if (declaredLicense !== 'Apache-2.0' || hash(standard) !== APACHE_TEMPLATE_SHA) return false;
  const marker = 'END OF TERMS AND CONDITIONS';
  const actual = original.toString('utf8'), template = standard.toString('utf8');
  const at = actual.indexOf(marker), end = template.indexOf(marker);
  if (at < 0 || end < 0 || actual.indexOf(marker, at + marker.length) !== -1) return false;
  // The optional appendix is application guidance. TypeScript's original
  // LICENSE retains all nine normative sections, omits that appendix, and
  // prints the four section-4 conditions without their (a)-(d) list markers.
  const normative = (text: string) => normalize(text.replace(/^[ \t]*\([abcd]\)[ \t]+/gmu, ''));
  const tail = normalize(actual.slice(at + marker.length));
  return normative(actual.slice(0, at)) === normative(template.slice(0, end))
    && (!tail || tail === normalize(template.slice(end + marker.length)));
}
/** Only explicit declarations are interpreted. This adapter supports the exact
 * MIT grant, so every other SPDX expression or explicit license override stays
 * pending; it does not guess permissions from ordinary prose/comments. */
export function explicitLicenseConflicts(bytes: Buffer, allowed: 'MIT' | 'Apache-2.0' | 'ISC' = 'MIT'): string[] {
  const text = bytes.toString('utf8');
  const declarations: string[] = [];
  for (const match of text.matchAll(/SPDX-License-Identifier:[ \t]*([^\r\n]+)/gu)) {
    const expression = match[1]!.replace(/[ \t]*(?:\*\/|-->|#>)[ \t]*$/u, '').trim();
    if (expression !== allowed) declarations.push('Explicit SPDX expression requires another grant adapter: ' + expression);
  }
  // Named @license/@licence declarations are explicit overrides, unlike generic
  // references to licenses in explanatory comments. No provider/license catalog.
  for (const match of text.matchAll(/@licen[cs]e[ \t]+([^\r\n]+)/gu)) {
    const declaration = match[1]!.replace(/[ \t]*(?:\*\/|-->)[ \t]*$/u, '').trim();
    if (declaration !== allowed) declarations.push('Explicit license declaration requires another grant adapter: ' + declaration);
  }
  for (const match of text.matchAll(/^[ \t]*(?:(?:\/\/|#|\*|<!--)[ \t]*)?(?:Licensed (?:under|on the terms of)|License:|Licensing:)[ \t]+([^\r\n]+)/gmu)) {
    const declaration = match[1]!.replace(/[ \t]*(?:\*\/|-->)[ \t]*$/u, '').trim();
    if (!(allowed === 'MIT' ? /^(?:the )?MIT(?: License)?\.?$/u.test(declaration) : allowed === 'ISC' ? /^(?:the )?ISC(?: License)?\.?$/u.test(declaration) : /^(?:the )?Apache License,? Version 2\.0(?: \(the "License"\))?[.;]?$/u.test(declaration))) declarations.push('Explicit license declaration requires another grant adapter: ' + declaration);
  }
  return [...new Set(declarations)].map(message => allowed === 'MIT' ? message : message.replace('another grant adapter', 'a grant outside ' + allowed + ' scope'));
}
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
  status: 'pending' | 'verified'; reason: string; pending: string[]; facts: LegalAdmissionFacts; coverage?: LegalCoverageReport;
  scope: 'mechanical per-member original grant, provenance and notice preservation; no external legal opinion or release qualification';
}

/** Pure exact-layout derivation, not an issuer. Generated files deliberately
 * do not acquire a grant by matching unrelated bytes elsewhere in the tree. */
export function deriveExactSourceGrantDeclaration(members: readonly CollectedArtifactMember[], source: Pick<DerivedSourceView, 'trackedPaths' | 'readTracked'>,
  sourcePrefix: string): { evidence?: ExactGrantEvidence; partialFiles: Binding[]; pending: string[] } {
  if (!safe(sourcePrefix) || members.length > 100000) fail('bounded canonical source layout required');
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
    if (/(?:^|\/)(?:node_modules|provenance|licenses|fixtures)(?:\/|$)/u.test(member.path)) { pending.push('Third-party or retained material requires its own original grant scope: ' + member.path); continue; }
    const local = sourcePrefix + '/' + member.path;
    // Shared repository notices are allowed only at the same notice basename.
    const sourcePath = tracked.has(local) ? local : ((notice(member.path) && !member.path.includes('/')) || (/^packages\/xpod-(?:api|css|afs)$/u.test(sourcePrefix) && /^(?:src|config|static|templates)\//u.test(member.path))) && tracked.has(member.path) ? member.path : undefined;
    if (!sourcePath || member.bytes > 4 * 1024 ** 2) { pending.push('No bounded exact canonical source mapping: ' + member.path); continue; }
    const bytes = source.readTracked(sourcePath);
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) { pending.push('Generated or changed archive member requires provenance grant adapter: ' + member.path); continue; }
    const grantSourcePath = nearestGrant(sourcePath);
    if (!grantSourcePath) { pending.push('Original scoped grant missing: ' + sourcePath); continue; }
    files.push({ path: member.path, sourcePath, grantSourcePath });
  }
  return pending.length ? { pending, partialFiles: files } : { pending: [], partialFiles: files, evidence: { schemaVersion: 1, kind: 'source-exact-license-grants', files } };
}

/** Original exact-source adapter surface (joined with separately verified axes): every archive file is an exact tracked
 * source file, applicable nearest ancestor LICENSE/COPYING files are genuine
 * MIT grants, and every applicable original notice is shipped byte-for-byte.
 * Bundles/generated/third-party supplemental provenance need a separate reviewed
 * adapter or real external-original capability; JSON URLs/hashes are not issuers.
 */
export function verifyLegalAdmission(evidence: unknown, context: Pick<AdmissionContext, 'collectedArtifact' | 'derivedSource' | 'package' | 'version' | 'sourceSha' | 'target'> & { legalOriginals?: readonly unknown[]; legalSourceMaterials?: unknown }): LegalAdmissionResult {
  const artifact = collectedArtifactView(context.collectedArtifact), source = derivedSourceView(context.derivedSource);
  const facts: LegalAdmissionFacts = { artifactCustodyVerified: Boolean(artifact), immutableSourceVerified: Boolean(source),
    exactFileCoverageVerified: false, originalNoticesVerified: false, normativeGrantVerified: false, legalQualified: false };
  const pending: string[] = [];
  let coverage: LegalCoverageReport | undefined;
  const result = (): LegalAdmissionResult => ({ status: facts.legalQualified ? 'verified' : 'pending',
    reason: pending.join('; ') || 'Exact source grant and retained original notices verified', pending: [...new Set(pending)], facts, ...(coverage ? { coverage } : {}),
    scope: 'mechanical per-member original grant, provenance and notice preservation; no external legal opinion or release qualification' });
  if (!artifact || !source) { pending.push('Real collected artifact and immutable Git source capabilities required'); return result(); }
  if (artifact.identity.package !== context.package || artifact.identity.version !== context.version
    || artifact.identity.sourceSha !== context.sourceSha || source.sourceSha !== context.sourceSha
    || artifact.identity.target !== context.target) fail('artifact/source/context identity mismatch');
  const manifest = readLegalProductManifest(artifact);
  if (manifest.name !== context.package || manifest.version !== context.version) fail('actual package manifest identity mismatch');
  const ledger = new LegalCoverageLedger(artifact.members);
  const template = source.trackedPaths.includes(MIT_TEMPLATE) ? source.readTracked(MIT_TEMPLATE) : undefined;
  const apacheTemplate = source.trackedPaths.includes(APACHE_TEMPLATE) ? source.readTracked(APACHE_TEMPLATE) : undefined;
  const iscTemplate = source.trackedPaths.includes(ISC_TEMPLATE) ? source.readTracked(ISC_TEMPLATE) : undefined;
  const physical = inspectPhysicalLegalMaterials(artifact, context.legalOriginals, (bytes, declaredLicense) =>
    Boolean(template && (declaredLicense === undefined || declaredLicense === 'MIT') && verifyMitGrantText(bytes, template)) || Boolean(apacheTemplate && verifyApacheGrantText(bytes, apacheTemplate, declaredLicense)) || Boolean(iscTemplate && verifyIscGrantText(bytes, iscTemplate, declaredLicense)),
    (bytes, declaredLicense) => explicitLicenseConflicts(bytes, declaredLicense === 'Apache-2.0' ? 'Apache-2.0' : declaredLicense === 'ISC' ? 'ISC' : 'MIT'), { source, materials: context.legalSourceMaterials, artifactCapability: context.collectedArtifact });
  if (physical) { pending.push(...physical.pending); for (const filename of physical.qualifiedPaths) ledger.cover(filename, 'physical-original', 'exact registry or observed-installed-source bytes and applicable scoped grant'); }
  pending.push(...inspectBundleLegalMaterials(artifact, context.legalOriginals, { source, materials: context.legalSourceMaterials, artifactCapability: context.collectedArtifact }).pending);
  const transpiled = inspectTranspiledLegalMappings(artifact, source, context.legalSourceMaterials, bytes => Boolean(template && verifyMitGrantText(bytes, template)), context.legalOriginals,
    (bytes, declaredLicense) => Boolean(apacheTemplate && verifyApacheGrantText(bytes, apacheTemplate, declaredLicense)), explicitLicenseConflicts);
  pending.push(...transpiled.pending);
  for (const filename of transpiled.coveredOutputs) ledger.cover(filename, 'transpiled-source', 'private compiler source/output mapping and original grants');
  for (const filename of transpiled.compilerOriginals) ledger.cover(filename, 'compiler-original', 'exact original TypeScript package and retained notices');
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
  let bindings: Binding[] = [];
  if (evidence === undefined) {
    const module = manifest.xpodModule?.id;
    const leaf = typeof module === 'string' && ['api', 'css', 'afs'].includes(module) ? 'xpod-' + module : context.package.split('/').pop();
    if (!leaf || !/^xpod-(?:client|cli|api|css|afs)$/u.test(leaf)) pending.push('Unregistered exact source layout');
    else {
      const already = new Set(ledger.report().entries.map(row => row.path));
      bindings = deriveExactSourceGrantDeclaration(artifact.members.filter(member => !already.has(member.path)), source, 'packages/' + leaf).partialFiles;
    }
  } else {
    const declaration = evidence as ExactGrantEvidence | null;
    if (declaration?.schemaVersion !== 1 || declaration.kind !== 'source-exact-license-grants' || !Array.isArray(declaration.files)) pending.push('No reviewed complete grant adapter for this evidence format');
    else bindings = declaration.files;
  }
  if (bindings.length > 20000) fail('grant coverage budget exceeded');
  const tracked = new Set(source.trackedPaths), seen = new Set<string>();
  for (const binding of bindings) {
    if (!binding || !safe(binding.path) || !safe(binding.sourcePath) || !safe(binding.grantSourcePath) || seen.has(binding.path)) fail('unsafe or duplicate source/grant binding');
    seen.add(binding.path);
    if (!tracked.has(binding.sourcePath) || !tracked.has(binding.grantSourcePath)) fail('source/grant absent from immutable Git');
    const scoped = inspectExactSourceGrantBinding(binding, artifact, source, bytes => Boolean(template && verifyMitGrantText(bytes, template)), explicitLicenseConflicts);
    pending.push(...scoped);
    if (!scoped.length) ledger.cover(binding.path, 'exact-source', binding.sourcePath);
  }
  coverage = ledger.report();
  if (!coverage.complete) pending.push('Whole archive grant coverage unresolved for ' + coverage.uncovered.length + ' actual members; see coverage.uncovered');
  facts.exactFileCoverageVerified = coverage.complete;
  facts.originalNoticesVerified = !pending.some(message => /notice|terms missing/iu.test(message));
  facts.normativeGrantVerified = !pending.some(message => /grant|copyright|license declaration|SPDX expression/iu.test(message));
  facts.legalQualified = coverage.complete && pending.length === 0;
  return result();
}
