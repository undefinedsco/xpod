import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { safeMaterialPath, sourceFileIndex } from '../../../packages/xpod-cli/src/source-materials';
import type { CollectedArtifactMember } from './artifact-contract';
import type { NativeFile } from '../physical-module-native';
const fail = (reason: string): never => { throw Error('Collected module native materials: ' + reason); };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ModuleNativeMaterialInput {
  module: 'api' | 'afs'; target: string; members: readonly CollectedArtifactMember[];
  sourcePins: Buffer; nativePolicySource?: Buffer;
  readMember(name: string, maximumBytes: number): Buffer;
}
/** Mechanical product-byte correspondence only; embedded upstream API JSON and
 * reused build receipts cannot confer official origin or actual runtime ABI. */
export function inspectModuleNativeMaterials(input: ModuleNativeMaterialInput) {
  const members = new Map(input.members.map(row => [row.path, row]));
  const reference = (name: string): NativeFile => {
    const row = members.get(name); if (!row || !safeMaterialPath(name)) return fail('registered product native member missing: ' + name);
    return Object.freeze({ path: name, sizeBytes: row.bytes, sha256: row.sha256 });
  };
  const original = (name: string, maximum = 8 * 1024 ** 2) => {
    const row = reference(name), bytes = input.readMember(name, maximum);
    if (row.sizeBytes > maximum || bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256) return fail('registered product original changed');
    return bytes;
  };
  const json = (name: string) => JSON.parse(original(name).toString());
  const pins = JSON.parse(input.sourcePins.toString());
  if (input.module === 'api') {
    const root = 'provenance/native/inngest/', index = json(root + 'index.json'), manifest = json('node_modules/inngest-cli/package.json');
    const asset = pins.assets?.[input.target], release = json(root + 'release.json'), tag = json(root + 'tag.json');
    if (!asset || manifest.name !== 'inngest-cli' || manifest.version !== pins.version || index.package !== manifest.name || index.version !== manifest.version
      || index.platform + '-' + index.arch !== input.target || index.sourceCommit !== pins.sourceCommit || index.sourceArchiveSHA256 !== pins.sourceArchive?.sha256
      || index.officialArchiveSHA256 !== asset.digest?.replace(/^sha256:/u, '') || release.id !== pins.releaseID || release.tag_name !== 'v' + pins.version
      || release.draft !== false || release.prerelease !== false || tag.ref !== 'refs/tags/v' + pins.version || tag.object?.type !== 'commit'
      || tag.object.sha !== pins.sourceCommit) return fail('immutable Inngest release/source/target pin differs from product originals');
    const assets = release.assets?.filter((row: any) => row.name === asset.name);
    if (!Array.isArray(assets) || assets.length !== 1 || Object.entries(asset).some(([key, value]) => assets[0][key] !== value)
      || index.releaseURL !== `https://github.com/${pins.repository}/releases/download/v${pins.version}/${asset.name}`
      || assets[0].browser_download_url !== index.releaseURL || index.sourceURL !== `https://api.github.com/repos/${pins.repository}/tarball/${pins.sourceCommit}`) return fail('Inngest asset identity/URL differs from pinned upstream tuple');
    const binary = reference('node_modules/inngest-cli/bin/inngest'), archive = reference(root + 'release.tar.gz'), source = reference(root + 'source.tar.gz');
    if (binary.sha256 !== index.binarySHA256 || reference('node_modules/inngest-cli/bin/LICENSE.md').sha256 !== index.licenseSHA256
      || archive.sha256 !== asset.digest.slice(7) || archive.sizeBytes !== asset.size
      || source.sha256 !== pins.sourceArchive.sha256 || source.sizeBytes !== pins.sourceArchive.bytes) return fail('actual Inngest binary/archive/source bytes differ from indexed originals');
    return Object.freeze({ binary, index: reference(root + 'index.json'), archive, sourceArchive: source,
      nativeSourceSha: pins.sourceCommit as string, data: Object.freeze({ index, release, tag }),
      pending: Object.freeze(['inngest-official-release-origin-capability-unavailable', 'inngest-release-binary-member-correspondence-unverified', 'inngest-native-build-toolchain-originals-unavailable', 'inngest-executed-runtime-ABI-originals-unavailable']) });
  }
  const indexPath = 'provenance/native-source-kit.json', kit = json(indexPath), receipt = json('provenance/native-build.receipt.json'), reuse = json('provenance/native-reuse.json');
  const authority = pins.artifacts?.[input.target], binary = reference('helper/agentfs-pod');
  const sourceArchive = reference('sources/native-source.tar.gz');
  const expectedEngine = /^UPSTREAM\s*=\s*'([a-f0-9]{40})'$/mu.exec(input.nativePolicySource?.toString() ?? '')?.[1];
  const expectedToolchain = /^TOOLCHAIN\s*=\s*'([^']+)'$/mu.exec(input.nativePolicySource?.toString() ?? '')?.[1];
  if (!authority || !expectedEngine || !expectedToolchain || kit.schemaVersion !== 1 || kit.status !== 'native-source-materials'
    || kit.engine?.commit !== expectedEngine || kit.toolchain !== expectedToolchain || !Array.isArray(kit.files) || kit.files.length > 250000
    || !kit.files.length || !isDeepStrictEqual(receipt.engine, kit.engine) || receipt.target !== input.target || reuse.target !== input.target
    || receipt.sourceFiles !== kit.files.length || receipt.compiler?.toolchain !== kit.toolchain || receipt.sourceKitSha256 !== reference(indexPath).sha256
    || reuse.sourceKitSHA256 !== receipt.sourceKitSha256 || authority.sourceKit !== receipt.sourceKitSha256
    || receipt.helperSha256 !== binary.sha256 || reuse.helperSHA256 !== binary.sha256 || authority.helper !== binary.sha256
    || reuse.nativeBuildSourceSHA !== pins.source || reuse.productHead !== pins.source || reuse.zipSHA256 !== authority.zip || reuse.archiveSHA256 !== authority.archive) return fail('AgentFS original helper/source-kit/reuse authority mismatch');
  sourceFileIndex(kit.files);
  if (reference('sources/native-source.json').sha256 !== reference(indexPath).sha256
    || reference('sources/native-source-build.json').sha256 !== reference('provenance/native-build.receipt.json').sha256) return fail('AgentFS retained source receipt copies differ');
  return Object.freeze({ binary, index: reference(indexPath), sourceArchive, nativeSourceSha: pins.source as string,
    data: Object.freeze({ kit, receipt, reuse, authority }),
    pending: Object.freeze(['agentfs-source-archive-membership-unverified', 'agentfs-compiler-sdk-input-closure-not-fully-bound', 'agentfs-original-native-producer-custody-unavailable', 'agentfs-executed-runtime-ABI-originals-unavailable']) });
}
