import { moduleSourceMaterialView } from './module-source-admission';
import { registryLegalOriginalView } from './legal-registry-originals';
import type { CollectedArtifactMember, CollectedArtifactView, DerivedSourceView } from './artifact-contract';

function fail(message: string): never { throw Error('TypeScript helper grants: ' + message); }
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !name.includes('\\')
  && !name.split('/').some(part => !part || part === '.' || part === '..');
const notice = (name: string) => /^(?:licen[cs]e|copying|notice|copyright|thirdpartynoticetext)(?:[._-].*)?$/iu.test(name.slice(name.lastIndexOf('/') + 1));

/** Parse only the actual compiler's static helper records. Never evaluate a
 * candidate compiler or interpolate its templates. Unknown shapes are absent,
 * and consequently cannot cover an emitted helper. */
export function parseTypeScriptStaticHelperRecords(text: string): Map<string, string> {
  if (Buffer.byteLength(text) > 131072) fail('helper record window exceeded');
  const helpers = new Map<string, string>();
  for (const match of text.matchAll(/\bvar [A-Za-z0-9_$]+Helper = \{\r?\n([\s\S]*?)\r?\n\};/gu)) {
    const block = match[1]!;
    if (!/\bname: "typescript:[^"]+"/u.test(block)) continue;
    const template = /\btext: `([\s\S]*)`\s*$/u.exec(block)?.[1];
    if (template === undefined || template.includes('${') || /\\[^\\`]/u.test(template)) continue;
    const decoded = template.replace(/\\([\\`])/gu, '$1');
    const lines = decoded.replace(/\r\n?/gu, '\n').split('\n').filter(line => line.trim());
    const indent = Math.min(...lines.map(line => /^[ \t]*/u.exec(line)![0].length));
    const emitted = lines.map(line => line.slice(indent)).join('\n');
    const name = /^var (__[A-Za-z0-9_$]+) = \(this && this\.\1\) \|\|/u.exec(emitted)?.[1];
    if (!name || helpers.has(name)) continue;
    helpers.set(name, emitted);
  }
  return helpers;
}

/** Pure byte-format check, not an original issuer or source capability. */
export function verifyTypeScriptEmittedHelperTexts(bytes: number, readRange: (offset: number, length: number) => Buffer,
  templates: ReadonlyMap<string, string>): string[] {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 32 * 1024 ** 2) fail('emitted output scan budget exceeded');
  const mismatches = new Set<string>(); let outputOverlap = '', scannedChars = 0;
  const checked = new Set<number>();
  for (let offset = 0; offset < bytes; offset += 65536) {
    const length = Math.min(65536, bytes - offset), buffer = readRange(offset, length);
    if (buffer.length !== length) fail('truncated emitted output read');
    const chunk = buffer.toString('utf8'), window = outputOverlap + chunk, base = scannedChars - outputOverlap.length;
    scannedChars += chunk.length;
    for (const match of window.matchAll(/(?:^|\n)([ \t]*)var (__[A-Za-z0-9_$]+) = /gu)) {
      const start = match.index! + (match[0]!.startsWith('\n') ? 1 : 0), absolute = base + start;
      if (checked.has(absolute)) continue;
      const template = templates.get(match[2]!);
      const expected = template?.split('\n').map(line => match[1]! + line).join('\n');
      if (expected && start + expected.length > window.length && offset + length < bytes) continue;
      checked.add(absolute);
      if (!expected || window.slice(start, start + expected.length).replace(/\r\n?/gu, '\n') !== expected) mismatches.add(match[2]!);
    }
    outputOverlap = window.slice(-32768);
  }
  return [...mismatches];
}

/** Complete actual compiler copy, including every upstream NOTICE and
 * copyright file. This pure inventory check does not issue original custody. */
export function verifyTypeScriptCompilerOriginalInventory(declarations: readonly { path: string; bytes: number; sha256: string }[],
  archiveMembers: readonly CollectedArtifactMember[], originalMembers: readonly CollectedArtifactMember[]): void {
  if (!Array.isArray(declarations) || declarations.length > 20000) fail('compiler original inventory budget exceeded');
  const prefix = 'provenance/compiler-originals/typescript/';
  const members = new Map(archiveMembers.map(row => [row.path, row])), upstream = new Map(originalMembers.map(row => [row.path, row]));
  const declared = new Set<string>();
  for (const row of declarations) {
    if (!safe(row?.path) || declared.has(row.path)) fail('unsafe or duplicate compiler original');
    declared.add(row.path);
    const actual = members.get(prefix + row.path), expected = upstream.get(row.path);
    if (!actual || !expected || row.bytes !== actual.bytes || row.sha256 !== actual.sha256 || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) fail('retained compiler original differs: ' + row.path);
  }
  if (declared.size !== upstream.size || [...upstream.keys()].some(name => !declared.has(name))) fail('actual compiler original inventory is incomplete');
  for (const member of archiveMembers) if (member.path.startsWith(prefix) && !declared.has(member.path.slice(prefix.length))) fail('unlisted compiler original member');
  for (const row of originalMembers.filter(row => notice(row.path))) if (!declared.has(row.path)) fail('applicable compiler notice missing: ' + row.path);
}

export function inspectTypeScriptHelperGrants(artifact: CollectedArtifactView, source: DerivedSourceView, sourceCapability: unknown,
  registryOriginals: readonly unknown[], verifyApache: (bytes: Buffer, declaredLicense: unknown) => boolean): { coveredOutputs: string[]; coveredCompilerOriginals?: string[]; pending: string[] } {
  const material = moduleSourceMaterialView(sourceCapability), coveredOutputs: string[] = [], pending: string[] = [];
  if (!material || !material.transpiledOutputs.length) return { coveredOutputs, pending };
  if (material.sourceSha !== source.sourceSha || material.sourceSha !== artifact.identity.sourceSha) fail('immutable source binding differs');
  const members = new Map(artifact.members.map(row => [row.path, row]));
  if (!members.has('provenance/compiler.json')) return { coveredOutputs, pending: ['Actual compiler original inventory required for emitted helpers'] };
  const compiler = JSON.parse(artifact.readMember('provenance/compiler.json', 1024 * 1024).toString());
  if (compiler.package !== 'typescript' || compiler.format !== 'commonjs' || compiler.target !== 'ES2021' || compiler.esModuleInterop !== true
    || !Array.isArray(compiler.originalCompilerFiles) || !Array.isArray(compiler.compiledSources)) return { coveredOutputs, pending: ['Unreviewed actual TypeScript emit recipe'] };
  const changedMappings = material.transpiledOutputs.filter(mapping => {
    const actual = members.get(mapping.path), bound = material.outputs.find(row => row.path === mapping.path);
    const declaration = compiler.compiledSources.find((row: any) => row.output === mapping.path && row.source === mapping.sourcePath);
    if (!actual || !bound || actual.sha256 !== bound.sha256 || actual.bytes !== bound.bytes || !declaration || declaration.outputSHA256 !== actual.sha256) fail('compiler output mapping differs');
    if (declaration.sourceSHA256 === actual.sha256) { coveredOutputs.push(mapping.path); return false; }
    return true;
  });
  if (!changedMappings.length) return { coveredOutputs, pending };
  const original = registryOriginals.map(registryLegalOriginalView).find(view => view?.sourceSha === source.sourceSha && view.name === 'typescript' && view.version === compiler.version);
  if (!original) return { coveredOutputs, pending: ['Immutable TypeScript registry original required: typescript@' + compiler.version] };
  const manifest = JSON.parse(original.readMember('package.json').toString());
  if (!verifyApache(original.readMember('LICENSE.txt'), manifest.license)) return { coveredOutputs, pending: ['Original TypeScript Apache normative grant is unverified'] };
  verifyTypeScriptCompilerOriginalInventory(compiler.originalCompilerFiles, artifact.members, original.members);
  const upstream = new Map(original.members.map(row => [row.path, row]));
  const compilerSource = upstream.get('lib/typescript.js');
  if (!compilerSource) return { coveredOutputs, pending: ['Original TypeScript helper implementation absent'] };
  const templates = new Map<string, string>(); let overlap = '';
  for (let offset = 0; offset < compilerSource.bytes; offset += 65536) {
    const chunk = original.readMemberRange('lib/typescript.js', offset, Math.min(65536, compilerSource.bytes - offset)).toString('utf8');
    const window = overlap + chunk;
    for (const [name, text] of parseTypeScriptStaticHelperRecords(window)) {
      if (templates.has(name) && templates.get(name) !== text) fail('conflicting compiler helper implementation');
      templates.set(name, text);
    }
    overlap = window.slice(-32768);
  }
  if (!templates.size) return { coveredOutputs, pending: ['No reviewed static helper records in actual TypeScript original'] };
  if (!artifact.readMemberRange) return { coveredOutputs, pending: ['Bounded emitted helper reader required'] };
  if (material.transpiledOutputs.length > 20000 || material.transpiledOutputs.reduce((total, row) => total + (members.get(row.path)?.bytes ?? 0), 0) > 128 * 1024 ** 2) fail('emitted output group scan budget exceeded');
  for (const mapping of changedMappings) {
    const actual = members.get(mapping.path), bound = material.outputs.find(row => row.path === mapping.path);
    const declaration = compiler.compiledSources.find((row: any) => row.output === mapping.path && row.source === mapping.sourcePath);
    if (!actual || !bound || actual.sha256 !== bound.sha256 || actual.bytes !== bound.bytes || !declaration || declaration.outputSHA256 !== actual.sha256) fail('compiler output mapping differs');
    const mismatches = verifyTypeScriptEmittedHelperTexts(actual.bytes,
      (offset, length) => artifact.readMemberRange!(mapping.path, offset, length), templates);
    for (const name of mismatches) pending.push('Actual emitted helper differs from compiler original: ' + mapping.path + ':' + name);
    if (!mismatches.length) coveredOutputs.push(mapping.path);
  }
  return { coveredOutputs, coveredCompilerOriginals: original.members.map(row => 'provenance/compiler-originals/typescript/' + row.path), pending: [...new Set(pending)] };
}
