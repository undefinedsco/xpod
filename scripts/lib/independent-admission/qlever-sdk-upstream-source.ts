import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import limits from '../module-artifact-limits.json';
import { qleverSdkOriginalsView } from './qlever-sdk-originals';
import { derivedSourceView, assertDerivedSourceCurrent } from './source-context';
import { sdkVerifiedInputOriginalView } from './qlever-sdk-source';
import { isDeepStrictEqual } from 'node:util';
import { captureLegalFileIdentity, assertLegalFileIdentity } from './legal-file-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function need(value: unknown, reason: string): asserts value { if (!value) throw Error('SDK upstream source: ' + reason); }
const HELPERS = [
  ['sdk-git-source-bindings.py', '612063f44d09932b93883db2d186d197bd828e07d39e2df430d9dbe574fd66d0'],
  ['sdk-git-source-observer.py', 'fd578d0fef97c1d3b4b60e5510320c109c6930580d91db9335d67cbacff186f6'],
  ['sdk-git-patch-projection.py', '3e4051b50acf6be11ade6e5d6c05ca23ab8376aa4ff5861975088eab642c8f23'],
  ['sdk-zip-originals.py', '2ca4929f58cfbdfeac43f2bf02564ffc46805de27b529e6e363080710e7c048d'],
] as const;
export function assertSdkUpstreamCollectionProjection(upstream: any, inner: any): void {
  const normalize = (value: any): any => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== 'object') return value;
      if (typeof value.path === 'string' && Number.isSafeInteger(value.bytes) && typeof value.sha256 === 'string') return {...value, path: 'inner/' + value.path};
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
    };
  const {innerMaterials: _innerReference, ...rooted} = upstream;
  need(isDeepStrictEqual(rooted, normalize(inner)), 'complete root/inner upstream source collection differs');
}

/** Same private SDK/source handles. This axis proves pinned Git preimages only;
 * it cannot bless the postpatch inventory, generated inputs or toolchain. */
export async function observeQleverSdkUpstreamGitOriginals(capability: unknown, sourceCapability: unknown, remainingMilliseconds = limits.timeoutMs) {
  const facts: Record<string, unknown> = {}, pending = new Set<string>();
  try {
    const sdk = qleverSdkOriginalsView(capability), source = derivedSourceView(sourceCapability);
    need(sdk && source && source.sourceSha === sdk.originFacts.sourceSha, 'same issued SDK and immutable source required'); assertDerivedSourceCurrent(sourceCapability);
    need(Number.isFinite(remainingMilliseconds) && remainingMilliseconds > 0, 'source observation window exhausted');
    const deadline = performance.now() + Math.min(remainingMilliseconds, limits.timeoutMs), check = () => need(performance.now() < deadline, 'aggregate Git source deadline exceeded');
    const originals = new Map(sdk.members.map(row => [row.path, row]));
    const ref = (value: any) => { check(); const actual = originals.get(value?.path); need(actual && actual.bytes === value.bytes && actual.sha256 === value.sha256, 'same SDK ZIP reference required'); return actual; };
    const json = (value: any, maximum = limits.metadataBytes) => { const original = ref(value); need(original.bytes <= maximum, 'bounded source metadata required'); const bytes = sdk.readOriginal(original.path, maximum); need(bytes.length === original.bytes && hash(bytes) === original.sha256, 'source metadata bytes differ'); return JSON.parse(bytes.toString()); };
    const master = json(sdk.masterReference, 8 * 1024 ** 2);
    need(master.kind === 'qlever-linux-sdk-originals' && master.identity?.sourceSha === source.sourceSha && master.identity?.target === sdk.originFacts.target, 'SDK source master differs');
    if (!master.upstreamSource) return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze(['qlever-sdk-upstream-Git-object-originals-unavailable'])});
    need(ref(master.upstreamSource).path === 'upstream-source-collection.json', 'fixed upstream source collection role required');
    const upstream = json(master.upstreamSource), lock = JSON.parse(source.readTracked('qlever/qlever.lock.json').toString());
    need(upstream.schemaVersion === 1 && upstream.kind === 'qlever-sdk-upstream-source-originals' && upstream.objectFormat === 'sha1'
      && upstream.objectIdsFormat === 'ascii-sorted-unique-sha1-lf' && upstream.sourceRoot === '/opt/qlever-sdk/source'
      && upstream.repository === lock.repository && upstream.commit === lock.commit, 'immutable lock repository/commit/object format differs');
    need(upstream.phaseBindings && ['configure', 'compile'].every(name => { const matches = master.stages.filter((stage: any) => stage.name === name); return matches.length === 1 && isDeepStrictEqual(upstream.phaseBindings[name], matches[0]); }), 'actual SDK configure/compile phase bindings differ');
    need(ref(upstream.innerMaterials).path === 'inner/upstream-source/final-materials.json', 'registered original inner upstream collection required');
    const inner = json(upstream.innerMaterials);
    assertSdkUpstreamCollectionProjection(upstream, inner);
    const configureReceipt = json(upstream.phaseBindings.configure.receipt), compileReceipt = json(upstream.phaseBindings.compile.receipt);
    const windows = upstream.hookWindows;
    need(windows && ['beforeEndedUnixNs', 'afterEndedUnixNs'].every(key => typeof windows[key] === 'string' && /^[0-9]+$/u.test(windows[key])), 'actual upstream hook windows required');
    const beforeHook = BigInt(windows.beforeEndedUnixNs), afterHook = BigInt(windows.afterEndedUnixNs);
    need(BigInt(configureReceipt.startedUnixNs) <= beforeHook && beforeHook <= afterHook && afterHook <= BigInt(configureReceipt.completedUnixNs)
      && BigInt(configureReceipt.completedUnixNs) <= BigInt(compileReceipt.startedUnixNs), 'actual Git source hooks must occur inside configure before compile');
    const verifiedInputs = sdkVerifiedInputOriginalView(capability);
    need(verifiedInputs && isDeepStrictEqual(ref(upstream.actualInputInventory), verifiedInputs.afterReference), 'actual full-shard input verification required');
    const selected = json(upstream.selectedInputs), post = json(upstream.postpatchInventory);
    need(selected.schemaVersion === 1 && Array.isArray(selected.files) && selected.files.length > 0 && Array.isArray(selected.unresolvedInputs) && post.schemaVersion === 1 && Array.isArray(post.files), 'actual selected/postpatch inventories required');
    const postRows = new Map<string, any>(post.files.map((row: any) => [row.path, row])), actualRows = new Map(verifiedInputs.rows.map(row => [row.originalPath, row]));
    need(postRows.size === post.files.length, 'unique postpatch paths required');
    const selectedPaths = new Set<string>();
    for (const item of selected.files) {
      check(); const relative = item.sourceRelativePath;
      need(typeof relative === 'string' && relative && !relative.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..')
        && item.originalPath === upstream.sourceRoot + '/' + relative && !selectedPaths.has(item.originalPath), 'canonical actual selected source path required');
      const row = actualRows.get(item.originalPath), projected = postRows.get(relative);
      need(row && projected && isDeepStrictEqual(item.postpatchEntry, projected) && row.bytes === projected.bytes && row.sha256 === projected.sha256 && row.mode === parseInt(projected.mode, 8) % 0o10000, 'selected actual shard bytes differ from postpatch projection'); selectedPaths.add(item.originalPath);
    }
    for (const item of selected.unresolvedInputs) {
      need(item.reason === 'selected-source-input-generated-after-patch-snapshot' && typeof item.path === 'string' && item.path.startsWith(upstream.sourceRoot + '/') && actualRows.has(item.path) && !selectedPaths.has(item.path), 'actual generated selected input required'); selectedPaths.add(item.path);
    }
    need(verifiedInputs.rows.filter(row => row.originalPath.startsWith(upstream.sourceRoot + '/')).every(row => selectedPaths.has(row.originalPath)), 'selected actual source input universe incomplete');
    need(Array.isArray(upstream.addedPaths) && upstream.addedPaths.length === 0 && Array.isArray(upstream.deletedPaths) && upstream.deletedPaths.length === 0, 'current reviewed text patch path universe must remain unchanged');
    const seriesBytes = source.readTracked('qlever/patches/series'), names = seriesBytes.toString().split('\n').map(name => name.trim()).filter(Boolean);
    need(names.length > 0 && new Set(names).size === names.length && names.every(name => /^[A-Za-z0-9_.-]+\.patch$/u.test(name)) && upstream.patchSeriesSourcePath === 'qlever/patches/series'
      && Array.isArray(upstream.patches) && upstream.patches.length === names.length, 'one immutable reviewed patch series required');
    const seriesDigest = createHash('sha256').update(seriesBytes);
    const reviewedPatches = names.map((name, index) => {
      const item = upstream.patches[index], sourcePath = 'qlever/patches/' + name;
      need(item.name === name && item.sourcePath === sourcePath && ref(item.file).path.startsWith('inner/upstream-source/'), 'ordered immutable patch original role differs');
      const bytes = source.readTracked(sourcePath); seriesDigest.update(name).update(Buffer.from([0])).update(bytes);
      return {name, file: ref(item.file), base64: bytes.toString('base64')};
    });
    need(seriesDigest.digest('hex') === lock.patchSeriesSha256, 'immutable reviewed patch series digest differs from lock');
    const lockRef = ref(upstream.lock); need(lockRef.path.startsWith('inner/upstream-source/') && sdk.readOriginal(lockRef.path, limits.metadataBytes).equals(source.readTracked('qlever/qlever.lock.json')), 'actual upstream lock bytes differ from immutable Git');
    for (const field of ['commitOriginal', 'treeListing', 'objectIds', 'prepatchInventory', 'objectPack']) need(ref(upstream[field]).path.startsWith('inner/upstream-source/'), 'fixed upstream original prefix required');
    const helpers = HELPERS.map(([name, expected]) => { const file = fileURLToPath(new URL('../../../qlever/scripts/' + name, import.meta.url)), identity = captureLegalFileIdentity(file); need(identity.size <= BigInt(limits.metadataBytes) && hash(readFileSync(file)) === expected, 'reviewed controller Git helper differs'); return identity; });
    const python = realpathSync('/usr/bin/python3'), pythonIdentity = captureLegalFileIdentity(python), git = realpathSync('/usr/bin/git'), gitIdentity = captureLegalFileIdentity(git);
    const limitsPath = fileURLToPath(new URL('../module-artifact-limits.json', import.meta.url)), limitsIdentity = captureLegalFileIdentity(limitsPath);
    const { moduleSourcePhasePolicy } = await import('./module-source-phases'); need(hash(readFileSync(limitsPath)) === moduleSourcePhasePolicy.limits, 'reviewed source budget differs');
    const identities = [...helpers, pythonIdentity, gitIdentity, limitsIdentity]; identities.forEach(assertLegalFileIdentity);
    const result = await sdk.withArchiveFile(async archive => {
      check(); need(archive.identity.bytes === sdk.archive.bytes && archive.identity.sha256 === sdk.archive.sha256, 'same retained SDK archive required');
      const plan = Buffer.from(JSON.stringify({remainingMilliseconds: Math.floor(deadline - performance.now()), commit: lock.commit, rootTree: upstream.rootTree, gitExecutable: git, reviewedPatches, reviewedSeriesBase64: seriesBytes.toString('base64'), patchSeries: ref(upstream.patchSeries), postpatchInventory: ref(upstream.postpatchInventory), addedPaths: upstream.addedPaths, deletedPaths: upstream.deletedPaths,
        ...Object.fromEntries(['commitOriginal', 'treeListing', 'objectIds', 'prepatchInventory', 'objectPack'].map(field => [field, ref(upstream[field])]))}));
      need(plan.length <= limits.metadataBytes, 'bounded fixed Git observer plan required');
      const bytes = execFileSync(python, ['-I', '-S', '-B', helpers[1]!.path, archive.path], {input: plan, maxBuffer: limits.metadataBytes,
        timeout: Math.max(1, Math.floor(deadline - performance.now())), env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, stdio: ['pipe', 'pipe', 'pipe']});
      return JSON.parse(bytes.toString());
    }, {check, remainingMs: () => deadline - performance.now()});
    identities.forEach(assertLegalFileIdentity); assertDerivedSourceCurrent(sourceCapability); check(); need(qleverSdkOriginalsView(capability) === sdk, 'SDK/source custody revoked');
    need(result.verified === true && result.commit === lock.commit && result.packBytes === upstream.objectPack.bytes && result.packSha256 === upstream.objectPack.sha256, 'actual pinned Git observation differs');
    facts.sdkUpstreamGitCommitTreePreimageClosureVerified = true; facts.sdkUpstreamGitOriginals = Object.freeze(result);
    need(result.patchProjection?.verified === true, 'actual reviewed patch projection required');
    facts.sdkUpstreamReviewedPatchProjectionVerified = true;
    facts.sdkSelectedUpstreamInputOriginalsVerified = selected.unresolvedInputs.length === 0;
    facts.sdkSelectedUpstreamInputCount = selected.files.length;
    facts.sdkSelectedUpstreamInputBytes = selected.files.reduce((sum: number, row: any) => sum + actualRows.get(row.originalPath)!.bytes, 0);
    if (selected.unresolvedInputs.length) pending.add('qlever-sdk-selected-upstream-inputs-generated-after-patch-snapshot');
  } catch (error) { pending.add((error as Error).message); }
  return Object.freeze({facts: Object.freeze(facts), pending: Object.freeze([...pending])});
}
