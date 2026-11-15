/** Pure-view adapters for workspace/helper grant algorithms. Nothing here
 * mints a source capability or claims a production positive: the actual
 * source-owned compiler declaration/private reader and trixie runtime source
 * getter are not delivered yet. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspectTranspiledLegalMappingView } from '../../scripts/lib/independent-admission/legal-source-mappings';
import { explicitLicenseConflicts } from '../../scripts/lib/independent-admission/legal-admission';
import { inspectTypeScriptHelperGrantsView, inspectTypeScriptHelperGrants, verifyTypeScriptEmittedHelperTexts } from '../../scripts/lib/independent-admission/legal-typescript-helpers';
import { inspectTranspiledLegalMappings } from '../../scripts/lib/independent-admission/legal-source-mappings';
import { verifyMitGrantText } from '../../scripts/lib/independent-admission/legal-admission';

const standard = readFileSync(new URL('../../packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt', import.meta.url));
const normative = standard.toString().slice(standard.toString().indexOf('Permission is hereby granted'));
const mit = Buffer.from('MIT License\n\nCopyright (c) 2025 Example Authors\n\n' + normative);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceSha = 'a'.repeat(40);

function workspaceFixture(outputPath = '/app/dist/main.js') {
  const sourceText = Buffer.from('export const value = 1;\n'), outputText = Buffer.from('"use strict";\nexports.value = 1;\n');
  const tracked = new Map<string, Buffer>([['src/main.ts', sourceText], ['LICENSE', mit]]);
  const artifactMembers = [
    { path: outputPath, mode: 0o644, bytes: outputText.length, sha256: sha(outputText) },
    { path: 'app/LICENSE', mode: 0o644, bytes: mit.length, sha256: sha(mit) },
  ];
  const material = { sourceSha, outputs: [{ path: outputPath, mode: 0o644, bytes: outputText.length, sha256: sha(outputText) },
    { path: 'app/LICENSE', mode: 0o644, bytes: mit.length, sha256: sha(mit) }],
    transpiledOutputs: [{ path: outputPath, sourcePath: 'src/main.ts' }] };
  const view = (overrides: Record<string, unknown> = {}) => ({ material, artifactSourceSha: sourceSha, sourceSha,
    trackedPaths: [...tracked.keys()], readTracked: (name: string) => tracked.get(name)!,
    artifactMembers, ...overrides });
  return { outputPath, sourceText, outputText, tracked, artifactMembers, material, view };
}

test('pure mapping view accepts an absolute runtime output key matched verbatim against relative Git source', () => {
  const f = workspaceFixture();
  const result = inspectTranspiledLegalMappingView(f.view() as any, bytes => verifyMitGrantText(bytes, standard));
  expect(result.coveredOutputs).toEqual(['/app/dist/main.js']);
  expect(result.sourceScopedOutputs).toEqual(['/app/dist/main.js']);
  expect(result.pending).toEqual([]);
  // No absolute-path normalization: a root-relative artifact key no longer matches.
  const relative = workspaceFixture('/app/dist/main.js');
  expect(() => inspectTranspiledLegalMappingView(relative.view({ artifactMembers: relative.artifactMembers.map(row => ({ ...row, path: 'app/dist/main.js' })) }) as any,
    bytes => verifyMitGrantText(bytes, standard))).toThrow('actual output inventory differs');
});

test('pure mapping view rejects mismatched source identity, changed output bytes and missing retained notice', () => {
  const f = workspaceFixture();
  expect(() => inspectTranspiledLegalMappingView(f.view({ material: { ...f.material, sourceSha: 'b'.repeat(40) } }) as any, () => true)).toThrow('source identity differs');
  expect(() => inspectTranspiledLegalMappingView(f.view({ artifactSourceSha: 'c'.repeat(40) }) as any, () => true)).toThrow('source identity differs');
  expect(() => inspectTranspiledLegalMappingView(f.view({ artifactMembers: [{ ...f.artifactMembers[0]!, sha256: 'f'.repeat(64) }, f.artifactMembers[1]!] }) as any, () => true))
    .toThrow('actual output inventory differs');
  const withoutNotice = inspectTranspiledLegalMappingView(f.view({ artifactMembers: [f.artifactMembers[0]!],
    material: { ...f.material, outputs: [f.material.outputs[0]!] } }) as any, bytes => verifyMitGrantText(bytes, standard));
  expect(withoutNotice.coveredOutputs).toEqual([]);
  expect(withoutNotice.pending).toContain('Applicable source notice is not retained: LICENSE');
  // An explicit non-MIT declaration is audited, never silently accepted.
  const override = workspaceFixture();
  override.tracked.set('src/main.ts', Buffer.from('// SPDX-License-Identifier: GPL-3.0-only\nexport const value = 1;\n'));
  override.material = { ...override.material, outputs: [{ ...override.material.outputs[0]!, bytes: override.artifactMembers[0]!.bytes }] };
  const declared = inspectTranspiledLegalMappingView(override.view({ artifactMembers: override.artifactMembers }) as any,
    bytes => verifyMitGrantText(bytes, standard), explicitLicenseConflicts);
  expect(declared.pending.join(' ')).toContain('SPDX expression requires another grant adapter');
});

test('helper core reads compiler evidence from a separate reader and never from the runtime artifact', () => {
  const f = workspaceFixture();
  const compiler = Buffer.from(JSON.stringify({ package: 'typescript', format: 'commonjs', esModuleInterop: true,
    version: '5.5.4', target: 'ES2020', originalCompilerFiles: [], compiledSources: [] }));
  const material = { sourceSha, outputs: f.material.outputs, transpiledOutputs: f.material.transpiledOutputs };
  const runtime = { sourceSha, members: f.artifactMembers, readMember: () => f.outputText, readMemberRange: (_n: string, o: number, l: number) => f.outputText.subarray(o, o + l) };
  // Compiler declaration exists only in the retained evidence reader.
  const evidence = { members: [{ path: 'provenance/compiler.json', mode: 0o644, bytes: compiler.length, sha256: sha(compiler) }], readMember: () => compiler };
  const result = inspectTypeScriptHelperGrantsView({ sourceSha, material, artifact: runtime, compilerEvidence: evidence,
    registryOriginals: [], verifyApache: () => false });
  expect(result.coveredOutputs).toEqual([]);
  expect(result.pending).toContain('Unreviewed actual TypeScript emit recipe');
  // Runtime-only evidence (no separate compiler declaration) cannot qualify.
  const missing = inspectTypeScriptHelperGrantsView({ sourceSha, material, artifact: { ...runtime, members: [...f.artifactMembers] },
    compilerEvidence: { members: f.artifactMembers, readMember: runtime.readMember }, registryOriginals: [], verifyApache: () => false });
  expect(missing.pending).toEqual(['Actual compiler original inventory required for emitted helpers']);
  // No structural registry object can stand in for the immutable issuer.
  const structural = inspectTypeScriptHelperGrantsView({ sourceSha,
    material: { sourceSha, outputs: f.material.outputs, transpiledOutputs: f.material.transpiledOutputs },
    artifact: runtime, compilerEvidence: evidence,
    registryOriginals: [{ legalQualified: true, sourceSha, name: 'typescript', version: '5.5.4', readMember: () => Buffer.from('{}'), members: [] }],
    verifyApache: () => true });
  expect(structural.pending).toContain('Unreviewed actual TypeScript emit recipe');
});

test('helper core rejects mismatched source identity and changed emitted helper text stays detectable', () => {
  const f = workspaceFixture();
  const runtime = { sourceSha: 'b'.repeat(40), members: f.artifactMembers, readMember: () => f.outputText, readMemberRange: (_n: string, o: number, l: number) => f.outputText.subarray(o, o + l) };
  const material = { sourceSha, outputs: f.material.outputs, transpiledOutputs: f.material.transpiledOutputs };
  expect(() => inspectTypeScriptHelperGrantsView({ sourceSha: 'c'.repeat(40), material, artifact: runtime,
    compilerEvidence: { members: [], readMember: () => Buffer.alloc(0) }, registryOriginals: [], verifyApache: () => false })).toThrow('immutable source binding differs');
  // The existing pure scan is unchanged and still flags a changed helper body.
  const template = 'var __importDefault = (this && this.__importDefault) || function (mod) {\n    return (mod && mod.__esModule) ? mod : { "default": mod };\n};';
  const templates = new Map([['__importDefault', template]]);
  const good = Buffer.from(template), changed = Buffer.from(template.replace('mod && mod.__esModule', 'mod || mod.__esModule'));
  expect(verifyTypeScriptEmittedHelperTexts(good.length, (offset, length) => good.subarray(offset, offset + length), templates)).toEqual([]);
  expect(verifyTypeScriptEmittedHelperTexts(changed.length, (offset, length) => changed.subarray(offset, offset + length), templates)).toEqual(['__importDefault']);
});

test('existing wrappers preserve exact behavior: private material resolution still required', () => {
  const f = workspaceFixture();
  const artifact: any = { identity: { sourceSha }, members: f.artifactMembers, readMember: () => Buffer.alloc(0), readMemberRange: () => Buffer.alloc(0) };
  const source: any = { sourceSha, trackedPaths: f.view().trackedPaths, readTracked: f.view().readTracked };
  // A structural material object is not a private source capability, so both
  // wrappers return their original empty/pending shape without granting.
  const structural = { sourceSha, outputs: f.material.outputs, transpiledOutputs: f.material.transpiledOutputs };
  expect(inspectTranspiledLegalMappings(artifact, source, structural, () => true)).toEqual({ sourceScopedOutputs: [], coveredOutputs: [], compilerOriginals: [], pending: [] });
  expect(inspectTypeScriptHelperGrants(artifact, source, structural, [], () => true)).toEqual({ coveredOutputs: [], pending: [] });
});

// Separate retained compiler evidence cannot stand in for shipped notices.
import { inspectTypeScriptRuntimeNotices } from '../../scripts/lib/independent-admission/legal-typescript-helpers';
test('compiler evidence and runtime notice retention remain distinct', () => {
  const original = [{path:'LICENSE.txt',bytes:7,sha256:'a'.repeat(64),mode:0o644}];
  expect(inspectTypeScriptRuntimeNotices(original, [])).toHaveLength(1);
  expect(inspectTypeScriptRuntimeNotices(original, [{...original[0]!,path:'/app/licenses/typescript.txt'}])).toEqual([]);
  expect(inspectTypeScriptRuntimeNotices(original, [{...original[0]!,sha256:'b'.repeat(64)}])).toHaveLength(1);
});
