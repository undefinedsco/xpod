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
  workflow: 'ce1e33a5f6a0052aa9d585f1556b6b07624cff0df3222d37ee4a5f9fc5f1046e',
});
const { resolveCatalogManifest } = createRequire(import.meta.url)('../../prepare-package-manifest.cjs') as { resolveCatalogManifest(manifest: any): any };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// The second reviewed supervisor only raises the command ceiling to 25 minutes;
// command closure, raw limits and receipt semantics remain identical.
const REVIEWED_SUPERVISORS = new Set([CLI_SOURCE_POLICY.supervisor,
  'e00e81eac425ece4ab9fa76701591af835fb41634bd366907e88a91cedde7513',
  // Exact fixed CLI parent / AFS-only lazy budget projection; no caller ceiling override.
  '57e1e940ab3022c655c155b0e14be86106fe1dd729212be379a3573ae199ca85',
  '7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27']);
/** The original reviewed combinations remain historical. The callback helper
 * is admitted only with its one actually reviewed current execution tuple. */
type CliSourceVersionGroup=Readonly<Record<keyof typeof CLI_SOURCE_POLICY,string>>&Readonly<{supervisors:readonly string[];workflows:readonly string[];sourceBindings?:readonly Readonly<{path:string;sha256:string}>[];secondarySourcePaths?:readonly string[]}>;
const PRE_SERVICE_CLI_SOURCE_VERSION_GROUPS:readonly CliSourceVersionGroup[]=Object.freeze([
 Object.freeze({...CLI_SOURCE_POLICY,supervisors:Object.freeze([...REVIEWED_SUPERVISORS]),workflows:Object.freeze([CLI_SOURCE_POLICY.workflow,'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb'])}),
 Object.freeze({...CLI_SOURCE_POLICY,sourceHelper:'c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850',supervisors:Object.freeze(['7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27']),workflows:Object.freeze([CLI_SOURCE_POLICY.workflow])}),
 Object.freeze({...CLI_SOURCE_POLICY,sourceHelper:'07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5',supervisors:Object.freeze(['7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27']),workflows:Object.freeze([CLI_SOURCE_POLICY.workflow])}),
 Object.freeze({...CLI_SOURCE_POLICY,sourceHelper:'1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2',supervisors:Object.freeze(['7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27']),workflows:Object.freeze([CLI_SOURCE_POLICY.workflow])}),
 Object.freeze({...CLI_SOURCE_POLICY,...{"producer":"099ce70c1565bed8802e1b6276f9216ab78cc4ebeb12df60592eb426252db110","sourceHelper":"1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2","supervisors":["7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27"],"workflows":["ce1e33a5f6a0052aa9d585f1556b6b07624cff0df3222d37ee4a5f9fc5f1046e"],"sourceBindings":[{"path":"scripts/prepare-package-manifest.cjs","sha256":"47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"bun.lock","sha256":"8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"}]}}),
 Object.freeze({...CLI_SOURCE_POLICY,...{"producer":"099ce70c1565bed8802e1b6276f9216ab78cc4ebeb12df60592eb426252db110","sourceHelper":"b582490cdbbd2b857fa6ce20d0b5d85a73605c90b96063a3c17bf7b38be93601","supervisors":["7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27"],"workflows":["ce1e33a5f6a0052aa9d585f1556b6b07624cff0df3222d37ee4a5f9fc5f1046e"],"sourceBindings":[{"path":"scripts/prepare-package-manifest.cjs","sha256":"47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"bun.lock","sha256":"8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"}]}}),
 Object.freeze({...CLI_SOURCE_POLICY,...{"producer":"099ce70c1565bed8802e1b6276f9216ab78cc4ebeb12df60592eb426252db110","sourceHelper":"99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16","supervisors":["7fb899a72bd50ae36b35649964e502c5984a97587ffd5570f6d830fb31d6bd27"],"workflows":["ce1e33a5f6a0052aa9d585f1556b6b07624cff0df3222d37ee4a5f9fc5f1046e"],"sourceBindings":[{"path":"scripts/prepare-package-manifest.cjs","sha256":"47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"},{"path":"scripts/platform-binaries.cjs","sha256":"95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"},{"path":"package.json","sha256":"9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"},{"path":"bun.lock","sha256":"8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"}]}}),
]);
const priorServiceCliGroup=PRE_SERVICE_CLI_SOURCE_VERSION_GROUPS[PRE_SERVICE_CLI_SOURCE_VERSION_GROUPS.length-1]!;
const serviceCliHashes:Readonly<Record<string,string>>=Object.freeze({'scripts/prepare-package-manifest.cjs':'c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2'});
export const CLI_SOURCE_VERSION_GROUPS:readonly CliSourceVersionGroup[]=Object.freeze([...PRE_SERVICE_CLI_SOURCE_VERSION_GROUPS,Object.freeze({...priorServiceCliGroup,secondarySourcePaths:Object.freeze(['scripts/prepare-package-manifest.cjs']),sourceBindings:Object.freeze([...(priorServiceCliGroup.sourceBindings??[]).map(row=>Object.freeze({...row,sha256:serviceCliHashes[row.path]??row.sha256})),Object.freeze({path:'scripts/workspace-package-payload.cjs',sha256:'edfdb44999a87551b744533019f5921e6098c65de7ccf63250e12858b9bcf48f'})])})]);
function reviewedCliSourceGroup(observed:Readonly<Record<keyof typeof CLI_SOURCE_POLICY,string>>,readTracked?:(name:string)=>Buffer):CliSourceVersionGroup|undefined{
 const candidates=CLI_SOURCE_VERSION_GROUPS.filter(group=>
  (['producer','publicationBudget','sourceHelper','sourceLimits','copier'] as const).every(key=>observed[key]===group[key])
  &&group.supervisors.some(value=>value===observed.supervisor)&&group.workflows.some(value=>value===observed.workflow));
 const roles=[...new Set(candidates.flatMap(group=>group.secondarySourcePaths??[]))];
 const owned=new Map<CliSourceVersionGroup,Map<string,string>>();
 for(const group of candidates){const rows=new Map<string,string>();for(const role of roles){const values=(group.sourceBindings??[]).filter(row=>row.path===role);if(!values.length||new Set(values.map(row=>row.sha256)).size!==1)fail('catalog CLI owned secondary original missing or conflicting');rows.set(role,values[0]!.sha256);}owned.set(group,rows);}
 if(roles.length&&!readTracked)return undefined;
 const observedRoles=new Map(roles.map(role=>[role,hash(readTracked!(role))]));
 const matches=candidates.filter(group=>roles.every(role=>observedRoles.get(role)===owned.get(group)!.get(role)));
 if(candidates.length&&roles.length&&matches.length!==1)fail('catalog CLI complete source binding mismatch: '+roles.join(','));
 return matches.length===1?matches[0]:undefined;
}
export function reviewedCliSourceVersion(observed:Readonly<Record<keyof typeof CLI_SOURCE_POLICY,string>>,readTracked?:(name:string)=>Buffer):boolean{return reviewedCliSourceGroup(observed,readTracked)!==undefined;}

const fail = (message: string): never => { throw new Error('Independent source rules: ' + message); };
const canonicalJson = (value: any): string => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonicalJson(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonicalJson(value[key]))])) : value);
export function verifyCliInputSet(
  files: Array<{ path: string }>, generatedBuildManifest: unknown,
  readTracked: (name: string) => Buffer, trackedPaths: readonly string[],
) {
  const producer = readTracked('scripts/check-cli-publication.cjs');
  const reviewedGroup=reviewedCliSourceGroup({producer:hash(producer),
    publicationBudget:hash(readTracked('scripts/lib/cli-publication-budget.cjs')),
    sourceHelper:hash(readTracked('scripts/lib/module-source-materials.py')),
    sourceLimits:hash(readTracked('scripts/lib/module-artifact-limits.json')),
    copier:hash(readTracked('scripts/cli-build-inputs.cjs')),
    supervisor:hash(readTracked('scripts/lib/afs-publication-command.cjs')),
    workflow:hash(readTracked('.github/workflows/cli-package.yml'))},readTracked);
  if (!reviewedGroup) {
    return { sourceInputSetVerified: false, generatedBuildManifestVerified: false,
      pending: 'source-input-policy-unreviewed: immutable producer/copier/supervisor/workflow differs from reviewed policy' };
  }
  for(const binding of reviewedGroup.sourceBindings??[])if(hash(readTracked(binding.path))!==binding.sha256)fail('catalog CLI complete source binding mismatch: '+binding.path);
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
  const root = resolveCatalogManifest(JSON.parse(readTracked('package.json').toString()));
  if (typeof root.devDependencies?.semver !== 'string') fail('root semver declaration missing');
  const expectedManifest = { name: 'xpod-cli-publication-build', private: true,
    workspaces: ['packages/xpod-cli', 'packages/xpod-client'],
    devDependencies: { ...cli.devDependencies, semver: root.devDependencies.semver } };
  if (canonicalJson(generatedBuildManifest) !== canonicalJson(expectedManifest)) fail('generated build manifest mismatch');
  return { sourceInputSetVerified: true, generatedBuildManifestVerified: true, pending: null };
}
