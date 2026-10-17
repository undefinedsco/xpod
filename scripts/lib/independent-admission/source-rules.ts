import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Reviewed producer revision includes owned command originals; workflow/copier
// retain S309 policy. These are policy
// digests, not product/source qualifications. Changes require a new review.
export const CLI_SOURCE_POLICY = Object.freeze({
  producer: 'ff0eb13abb628addad1c8fdfd3ee6d615215325e9ad7bc8799139a056e316c75',
  publicationBudget: 'de2a337b143edec3c903dd9bb0234755594f34b2cfdf43efad04661296c262d2',
  sourceHelper: 'cc4592e9649eb9f8e92140d9674beb90b78a769d7563df01f5d2971bfdf13258',
  sourceLimits: 'c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4',
  supervisor: '7710a6ee87729f202c67500fc83d0fc71509ac7e1034d1f22276f53a3fcf6781',
  copier: 'c437aa115b5b7905c539386d4df284a43e26782c846d62045d69de5bb762331c',
  workflow: 'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb',
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// The second reviewed supervisor only raises the command ceiling to 25 minutes;
// command closure, raw limits and receipt semantics remain identical.
const REVIEWED_SUPERVISORS = new Set([CLI_SOURCE_POLICY.supervisor,
  'e00e81eac425ece4ab9fa76701591af835fb41634bd366907e88a91cedde7513',
  // Exact fixed CLI parent / AFS-only lazy budget projection; no caller ceiling override.
  '57e1e940ab3022c655c155b0e14be86106fe1dd729212be379a3573ae199ca85',
  '7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27']);
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
    || hash(readTracked('scripts/lib/cli-publication-budget.cjs')) !== CLI_SOURCE_POLICY.publicationBudget
    || hash(readTracked('scripts/lib/module-source-materials.py')) !== CLI_SOURCE_POLICY.sourceHelper
    || hash(readTracked('scripts/lib/module-artifact-limits.json')) !== CLI_SOURCE_POLICY.sourceLimits
    || hash(readTracked('scripts/cli-build-inputs.cjs')) !== CLI_SOURCE_POLICY.copier
    || !REVIEWED_SUPERVISORS.has(hash(readTracked('scripts/lib/afs-publication-command.cjs')))
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
