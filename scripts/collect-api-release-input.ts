import { parsePhysicalPackReceipt } from './lib/physical-pack-receipt';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { MODULE_API_VERSION, modulePackageName, MODULE_TARGETS } from '../packages/xpod-cli/src/module-catalog';
import { exactVersion, type ProductInputReceipt, type Reference } from './independent-release-plan';
const { inspectTarballBuffer, sha512Integrity } = createRequire(import.meta.url)('./workspace-package-payload.cjs');
export interface ApiCollectionInput {
  schemaVersion: 1;
  expectedSourceSha: string;
  archive: Reference;
  packReceipt: Reference;
  stageRoot?: string;
  sourceWorkspace?: { root: string; build: string };
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function fail(message: string): never { throw new Error('API input collection: ' + message); }
function file(file: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('regular original material required');
  return readFileSync(file);
}
function reference(filePath: string): Reference { return { path: filePath, sha256: hash(file(filePath)) }; }
function bound(ref: Reference, base: string): { ref: Reference; data: Buffer } {
  if (!ref || !ref.path || !/^[a-f0-9]{64}$/u.test(ref.sha256)) fail('explicit original reference required');
  const absolute = path.resolve(base, ref.path), data = file(absolute);
  if (hash(data) !== ref.sha256) fail('original reference hash mismatch');
  return { ref: { path: absolute, sha256: ref.sha256 }, data };
}
/** Normal producer JSON stdout, optionally preceded by Bun's recorded command line. */
export function parseApiPackReceipt(data: Buffer): any { return parsePhysicalPackReceipt(data, fail); }
/** Reads originals and invokes existing stage verification when its exact historical inputs exist. */
export async function collectApiReleaseInput(input: ApiCollectionInput, base = process.cwd()) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(input.expectedSourceSha)) fail('exact source and existing materials required');
  const stage = input.stageRoot ? path.resolve(base, input.stageRoot) : undefined;
  if (stage && (!lstatSync(stage).isDirectory() || lstatSync(stage).isSymbolicLink())) fail('existing physical stage required');
  const archive = bound(input.archive, base), pack = bound(input.packReceipt, base);
  const integrity = sha512Integrity(archive.data);
  const packed = parseApiPackReceipt(pack.data);
  if (packed.sha256 !== archive.ref.sha256 || packed.integrity !== integrity) fail('pack receipt archive binding mismatch');
  const inspected = inspectTarballBuffer(archive.data), manifest = inspected.manifest;
  const module = manifest.xpodModule;
  const target = MODULE_TARGETS.find(row => row.platform === module?.platform && row.arch === module?.arch);
  if (!target || module.id !== 'api' || module.schemaVersion !== 1 || module.cliApiVersion !== MODULE_API_VERSION
    || manifest.name !== modulePackageName('api', target.platform, target.arch) || !exactVersion(manifest.version)
    || (manifest.private !== undefined && typeof manifest.private !== 'boolean')) fail('API package target/ABI/version mismatch');
  const members = new Map<string, any>();
  for (const entry of inspected.entries) {
    if (!entry.path.startsWith('package/')) fail('non-package archive member');
    if (entry.type === 'file') members.set(entry.path.slice(8), entry);
  }
  if (packed.members !== members.size) fail('pack receipt member count mismatch');
  const stageFiles: string[] = [];
  function visit(directory: string, relative = ''): void {
    for (const name of readdirSync(directory)) {
      const next = relative ? relative + '/' + name : name, absolute = path.join(directory, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('stage symlink rejected');
      if (stat.isDirectory()) visit(absolute, next);
      else if (stat.isFile()) {
        const member = members.get(next), data = file(absolute);
        if (!member || member.sha256 !== hash(data) || member.size !== data.length || member.mode !== (stat.mode & 0o7777)) fail('archive/stage inventory drift');
        stageFiles.push(next);
      } else fail('stage nonregular member rejected');
    }
  }
  if (stage) visit(stage);
  if ((stage && stageFiles.length !== members.size) || !Array.isArray(module.files) || module.files.length !== members.size - 1
    || new Set(module.files.map((row: any) => row.path)).size !== module.files.length) fail('module member inventory mismatch');
  for (const row of module.files) {
    const member = members.get(row.path);
    if (!member || row.path === 'package.json' || member.sha256 !== row.sha256 || member.size !== row.size || member.mode !== row.mode) fail('module member inventory mismatch');
  }
  if (!module.files.some((row: any) => row.path === module.entry)) fail('module entry absent');
  const material = (relative: string) => {
    if (!members.has(relative)) fail('required archived material missing: ' + relative);
    const entry = members.get(relative)!;
    const ref = stage ? reference(path.join(stage, relative)) : undefined;
    if (ref && ref.sha256 !== entry.sha256) fail('stage material changed during collection');
    return { ref, original: { archive: archive.ref, member: 'package/' + relative, sha256: entry.sha256 }, value: JSON.parse(entry.content.toString()) };
  };
  const source = material('provenance/source-inventory.json');
  const release = material('provenance/release-status.json');
  const publication = material('provenance/publication.json');
  const terms = material('provenance/terms/index.json');
  if (source.value.schemaVersion !== 1 || source.value.sourceAuthority?.sourceCommit !== input.expectedSourceSha
    || release.value.sourceAuthority?.sourceCommit !== input.expectedSourceSha) fail('original source identity mismatch');
  if (!Array.isArray(source.value.files) || typeof source.value.sourceAuthority.dirty !== 'boolean'
    || source.value.sourceAuthority.snapshotSHA256 !== hash(Buffer.from(JSON.stringify(source.value.files)))
    || release.value.sourceAuthority.snapshotSHA256 !== source.value.sourceAuthority.snapshotSHA256
    || release.value.sourceAuthority.dirty !== source.value.sourceAuthority.dirty
    || release.value.sourceAuthority.scope !== source.value.sourceAuthority.scope) fail('source inventory authority mismatch');
  const sourcePaths = source.value.files.map((row: any) => row.path);
  if (new Set(sourcePaths).size !== sourcePaths.length || JSON.stringify(sourcePaths) !== JSON.stringify([...sourcePaths].sort())) fail('source inventory ordering mismatch');
  for (const row of source.value.files) {
    const member = members.get('source/' + row.path);
    if (!member || row.sha256 !== member.sha256 || row.bytes !== member.size || typeof row.tracked !== 'boolean') fail('archived original source inventory drift');
  }
  if (terms.value.schemaVersion !== 1 || terms.value.status !== 'original-material-collection'
    || terms.value.legalClearance !== false || !Array.isArray(terms.value.entries)) fail('original terms inventory required');
  if (publication.value.schemaVersion !== 1 || !['preview', 'release'].includes(publication.value.mode)
    || publication.value.version !== manifest.version || (publication.value.sourceCommit !== null
    && publication.value.sourceCommit !== input.expectedSourceSha)) fail('publication source/version mismatch');
  if (publication.value.mode === 'release' && (publication.value.sourceCommit !== input.expectedSourceSha
    || source.value.sourceAuthority.dirty !== false || publication.value.declaredSourceClean !== true)) fail('release source declaration mismatch');
  const blockers = ['formal-source-native-legal-consumer-admission-unverified'];
  const nativeMaterials = [...members.keys()].filter(name => name.startsWith('provenance/native/') && name.endsWith('/index.json')).map(name => material(name));
  if (!nativeMaterials.length) blockers.push('native-original-material-index-unavailable');
  if (manifest.private === true || publication.value.mode !== 'release') blockers.push('preview-not-publishable');
  if (!stage) blockers.push('stage-verifier-unavailable');
  if (!input.sourceWorkspace) blockers.push('source-stage-verifier-unavailable');
  else {
    if (!stage) fail('source workspace verification also requires the existing stage');
    const workspace = realpathSync(path.resolve(base, input.sourceWorkspace.root));
    const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
    if (actual.status !== 0 || actual.stdout.trim() !== input.expectedSourceSha) fail('historical source workspace mismatch');
    const { verifyApiStageMaterials } = await import('../packages/xpod-api/scripts/bundle-stage');
    verifyApiStageMaterials(workspace, path.resolve(workspace, input.sourceWorkspace.build), stage);
  }
  const envelope: ProductInputReceipt = { schemaVersion: 1, kind: 'independent-product-input', sourceSha: input.expectedSourceSha,
    package: manifest.name, version: manifest.version, target: `${target.platform}-${target.arch}`,
    archiveSHA256: archive.ref.sha256, integrity, gates: { ...(release.ref ? { source: release.ref } : {}), ...(terms.ref ? { legal: terms.ref } : {}) } };
  return { schemaVersion: 1, kind: 'api-release-input-collection', status: 'blocked', published: false, releaseQualified: false,
    candidatePlanGenerated: false, sourceSha: input.expectedSourceSha, target: envelope.target, archive: archive.ref,
    packReceipt: pack.ref, materials: { source: source.original, release: release.original, publication: publication.original, terms: terms.original,
      native: nativeMaterials.map(row => row.original) },
    blockers, plannerReceiptDocument: envelope,
    limitations: ['The binding envelope must be saved and referenced explicitly before planner use; it is not admission evidence.',
      'Existing source/native/legal/consumer judgments are not promoted by collection.',
      'The existing strict tar reader buffers and inflates the full archive; large originals require a separate resource window.'] };
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) fail('one input JSON file required');
    const inputFile = path.resolve(process.argv[2]);
    console.log(JSON.stringify(await collectApiReleaseInput(JSON.parse(file(inputFile).toString()), path.dirname(inputFile)), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
