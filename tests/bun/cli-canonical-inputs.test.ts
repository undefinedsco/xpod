import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { verifyCanonicalPublicationInputs } from '../../scripts/prepare-cli-publication';
import rules from '../../packages/xpod-cli/scripts/canonical-host-sources.json';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const git = (file: string) => execFileSync('git', ['show', sha + ':' + file]);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const prefix = 'package/dist/producer-materials/';
  const members: any[] = [], index: any = { files: [], clientMetafile: 'client-inputs.json', clientPayloads: {} };
  const put = (name: string, content: Buffer) => {
    const old = members.findIndex(row => row.path === prefix + name); if (old >= 0) members.splice(old, 1);
    index.files = index.files.filter((row: any) => row.path !== name);
    members.push({ path: prefix + name, type: 'file', content });
    index.files.push({ path: name, bytes: content.length, sha256: hash(content) });
  };
  put('source/scripts/canonical-host-sources.json', git('packages/xpod-cli/scripts/canonical-host-sources.json'));
  for (const name of rules) put('source/repository/src/' + name, git('src/' + name));
  const content = git('packages/xpod-cli/src/client.ts'); put('source/src/client.ts', content);
  const meta = { inputs: { 'src/client.ts': { bytes: content.length, imports: [] as any[] } }, outputs: {} };
  const save = () => put('client-inputs.json', Buffer.from(JSON.stringify(meta)));
  save();
  for (const [file, key] of [['client.cjs', 'cjsSHA256'], ['client.mjs', 'esmSHA256']]) {
    const payload = Buffer.from('synthetic payload, not a build proof');
    members.push({ path: 'package/dist/' + file, type: 'file', content: payload }); index.clientPayloads[key] = hash(payload);
  }
  return { members, index, put, meta, save, verify: () => verifyCanonicalPublicationInputs(members, index, prefix + 'index.json', sha) };
}
test('compares preserved source against caller-selected Git revision without granting closure', () => {
  expect(fixture().verify().completeRuntimeClosure).toBe(false);
});
test('rejects substituted canonical rules even with updated producer hashes', () => {
  const f = fixture(); f.put('source/scripts/canonical-host-sources.json', Buffer.from('[]')); expect(f.verify).toThrow('rules');
});
test('rejects substituted canonical source even with updated producer hashes', () => {
  const f = fixture(); f.put('source/repository/src/' + rules[0], Buffer.from('wrong source')); expect(f.verify).toThrow('trusted repository');
});
test('rejects omitted imported input', () => {
  const f = fixture(); f.meta.inputs['src/client.ts'].imports.push({ path: 'src/lib/missing.ts' }); f.save(); expect(f.verify).toThrow('Omitted');
});
test('rejects wrong source path and undeclared external service', () => {
  const f = fixture(); (f.meta.inputs as any)['../../src/storage/server.ts'] = {}; f.save(); expect(f.verify).toThrow('Unexpected');
  const g = fixture(); g.meta.inputs['src/client.ts'].imports.push({ path: '@solid/community-server', external: true }); g.save(); expect(g.verify).toThrow('external');
});
test('rejects absent canonical member and replaced payload', () => {
  const f = fixture(); f.members.splice(f.members.findIndex(row => row.path.endsWith('repository/src/' + rules[0])), 1); expect(f.verify).toThrow('binding');
  const g = fixture(); g.members.find(row => row.path === 'package/dist/client.cjs').content = Buffer.from('replacement'); expect(g.verify).toThrow('output binding');
});
