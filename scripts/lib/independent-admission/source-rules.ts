import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Reviewed producer revision includes owned command originals; workflow/copier
// retain S309 policy. These are policy
// digests, not product/source qualifications. Changes require a new review.
export const CLI_SOURCE_POLICY = Object.freeze({
  producer: '6840be0b9a75859cbe528347884198de054d1eaf58df1d2ad625c441193dbdd5',
  supervisor: '7710a6ee87729f202c67500fc83d0fc71509ac7e1034d1f22276f53a3fcf6781',
  copier: 'c437aa115b5b7905c539386d4df284a43e26782c846d62045d69de5bb762331c',
  workflow: 'b9bc591d5248773fae30df574a95e1ee928dffc41ad5965a8fbc8bf90319d860',
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Independent source rules: ' + message); };
const canonicalJson = (value: any): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonicalJson(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonicalJson(value[key]))])) : value);
export function verifyCliInputSet(
  files: Array<{ path: string }>, generatedBuildManifest: unknown,
  readTracked: (name: string) => Buffer, trackedPaths: readonly string[],
) {
  const producer = readTracked('scripts/check-cli-publication.cjs');
  if (hash(producer) !== CLI_SOURCE_POLICY.producer
    || hash(readTracked('scripts/cli-build-inputs.cjs')) !== CLI_SOURCE_POLICY.copier
    || hash(readTracked('scripts/lib/afs-publication-command.cjs')) !== CLI_SOURCE_POLICY.supervisor
    || hash(readTracked('.github/workflows/cli-package.yml')) !== CLI_SOURCE_POLICY.workflow) {
    return { sourceInputSetVerified: false, generatedBuildManifestVerified: false,
      pending: 'source-input-policy-unreviewed: immutable producer/copier/supervisor/workflow differs from reviewed policy' };
  }
  // The copier is the sole owner of these declarations. Do not execute the
  // candidate source: the module below belongs to this reviewed verifier checkout.
  const require = createRequire(import.meta.url);
  const copier = require.resolve('../../cli-build-inputs.cjs');
  if (hash(readFileSync(copier)) !== CLI_SOURCE_POLICY.copier) fail('verifier copier policy drift');
  const { CLI_ENTRIES, CLIENT_ENTRIES } = require(copier);
  const expected = new Set<string>();
  const add = (name: string) => {
    const matches = trackedPaths.filter(file => file === name || file.startsWith(name + '/'));
    if (!matches.length) fail('required tracked build input absent: ' + name);
    for (const file of matches) expected.add(file);
  };
  for (const entry of CLI_ENTRIES) add('packages/xpod-cli/' + entry);
  for (const entry of CLIENT_ENTRIES) add('packages/xpod-client/' + entry);
  add('types/bun'); add('LICENSE');
  const hosts = JSON.parse(readTracked('packages/xpod-cli/scripts/canonical-host-sources.json').toString());
  if (!Array.isArray(hosts) || new Set(hosts).size !== hosts.length) fail('invalid canonical host declaration');
  for (const relative of hosts) {
    if (typeof relative !== 'string' || !/^[A-Za-z0-9/_-]+\.ts$/u.test(relative) || relative.includes('..')) fail('invalid canonical host path');
    add('src/' + relative);
  }
  // Read fixed syntax only after matching the reviewed producer digest. This
  // follows its declarations without a second hand-maintained tool/file list.
  const source = producer.toString();
  const strings = (text: string) => [...text.matchAll(/'([^']*)'/gu)].map(match => match[1]);
  const declaration = (name: string) => {
    const match = source.match(new RegExp('const ' + name + ' = \\[([^\\]]*)\\];'));
    if (!match) fail('reviewed producer declaration absent');
    return strings(match![1]);
  };
  for (const name of declaration('TOOLS')) add(name);
  for (const name of declaration('PATCHES')) add('scripts/' + name);
  const additional = source.match(/const additional = \[\.\.\.TOOLS, \.\.\.PATCHES\.map\(name => 'scripts\/' \+ name\), ([^\]]*)\];/u);
  if (!additional) fail('reviewed producer additional declaration absent');
  for (const name of strings(additional![1])) add(name);
  // The frozen publication lock is explicitly appended after producer execution.
  const lock = source.match(/const lock = path\.join\(root, '([^']+)'\);/u);
  if (!lock) fail('reviewed lock declaration absent');
  add(lock![1]);
  const listed = new Set(files.map(row => row.path));
  if (listed.size !== files.length || listed.size !== expected.size || [...expected].some(name => !listed.has(name))) fail('complete build input set mismatch');
  const cli = JSON.parse(readTracked('packages/xpod-cli/package.json').toString());
  const root = JSON.parse(readTracked('package.json').toString());
  if (typeof root.devDependencies?.semver !== 'string') fail('root semver declaration missing');
  const expectedManifest = { name: 'xpod-cli-publication-build', private: true,
    workspaces: ['packages/xpod-cli', 'packages/xpod-client'],
    devDependencies: { ...cli.devDependencies, semver: root.devDependencies.semver } };
  if (canonicalJson(generatedBuildManifest) !== canonicalJson(expectedManifest)) fail('generated build manifest mismatch');
  return { sourceInputSetVerified: true, generatedBuildManifestVerified: true, pending: null };
}
