import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { applyVerifierUnifiedPatch, inspectAfsVerifierPatchedPackages, projectReviewedInstalledPackage } from '../../scripts/lib/independent-admission/afs-verifier-patch-originals';

it('projects the real reviewed oidc patch once and rejects duplicate or changed upstream bytes', () => {
  const patch = readFileSync(path.resolve(__dirname, '../../patches/oidc-provider@9.5.1.patch'));
  const lines = patch.toString().trimEnd().split('\n'), header = lines.findIndex(line => line.startsWith('@@'));
  const oldStart = Number(/^@@ -(\d+)/u.exec(lines[header]!)![1]);
  const before = lines.slice(header + 1).filter(line => !line.startsWith('+')).map(line => line.slice(1));
  const original = Buffer.from([...Array.from({length: oldStart - 1}, (_, index) => '// upstream line ' + index), ...before].join('\n') + '\n');
  const name = 'lib/shared/session.js', projected = applyVerifierUnifiedPatch(new Map([[name, original]]), patch).get(name)!;
  expect(projected.toString()).toContain("ctx.response.set('set-cookie', setCookie);");
  expect(() => applyVerifierUnifiedPatch(new Map([[name, projected]]), patch)).toThrow('exact upstream preimage differs');
  expect(() => applyVerifierUnifiedPatch(new Map([[name, Buffer.from(original.toString().replace('/* eslint-enable */', '/* changed upstream */'))]]), patch)).toThrow('exact upstream preimage differs');
});

it('rejects escaping paths, fuzzy coordinates, and binary or unsupported records', () => {
  const source = new Map([['file', Buffer.from('one\ntwo\n')]]);
  const patch = '--- a/file\n+++ b/file\n@@ -1,1 +1,1 @@\n-one\n+changed\n';
  expect(applyVerifierUnifiedPatch(source, Buffer.from(patch)).get('file')!.toString()).toBe('changed\ntwo\n');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch.replaceAll('a/file', 'a/../file').replaceAll('b/file', 'b/../file')))).toThrow('canonical unique');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch.replace('-1,1', '-2,1')))).toThrow('exact upstream preimage');
  expect(() => applyVerifierUnifiedPatch(source, Buffer.from(patch + 'GIT binary patch\n'))).toThrow('unsupported patch record');
});

it('never accepts serialized source or registry approvals as patch authority', () => {
  const actual = inspectAfsVerifierPatchedPackages({source: {sourceSha: 'a'.repeat(40), readTracked: () => Buffer.from('fabricated')}, originals: [{name: 'jose', version: '5.0.0', verified: true}], packages: [{name: 'jose', version: '5.0.0', path: 'node_modules/jose', logicalPaths: ['node_modules/jose']}], files: []});
  expect(actual.verified).toBe(false);
  expect(actual.pending).toContain('AFS verifier patch: immutable private source required');
});

it('supports every hunk and file in all three real Bun patch originals', () => {
  for (const filename of ['oidc-provider@9.5.1.patch', '@undefineds.co%2Fdrizzle-solid@0.3.25.patch', '@solid%2Fcommunity-server@8.0.0-alpha.1.patch']) {
    const patch = readFileSync(path.resolve(__dirname, '../../patches', filename)), files = new Map<string, string[]>();
    let name = '', at = 0, inHunk = false, previous = ''; const noNewline = new Set<string>();
    for (const line of patch.toString().split('\n')) {
      if (line.startsWith('--- a/')) {name = line.slice(6); files.set(name, []); inHunk = false;}
      else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++ ')) inHunk = false;
      else if (line.startsWith('@@ ')) {at = Number(/^@@ -(\d+)/u.exec(line)![1]) - 1; inHunk = true;}
      else if (line === '\\ No newline at end of file') {if (previous !== '+') noNewline.add(name);}
      else if (inHunk && (line.startsWith(' ') || line.startsWith('-'))) {previous = line[0]!;const lines = files.get(name)!; if (lines[at] !== undefined) expect(lines[at]).toBe(line.slice(1)); lines[at++] = line.slice(1);}
      else if (inHunk && line.startsWith('+')) previous = '+';
    }
    const originals = new Map([...files].map(([name, lines]) => [name, Buffer.from(Array.from({length: lines.length}, (_, index) => lines[index] ?? '// unchanged upstream ' + index).join('\n') + (noNewline.has(name) ? '' : '\n'))]));
    const actual = applyVerifierUnifiedPatch(originals, patch);
    expect(actual.size).toBe(files.size);
    expect(() => applyVerifierUnifiedPatch(actual, patch)).toThrow();
  }
});

it('shared selected projection still requires actual private source and sole registry capability',()=>{
 expect(()=>projectReviewedInstalledPackage({source:{sourceSha:'a'.repeat(40)},original:{name:'negotiate',version:'1.0.1',verified:true},logicalPaths:['node_modules/negotiate']})).toThrow('immutable private source required');
});
