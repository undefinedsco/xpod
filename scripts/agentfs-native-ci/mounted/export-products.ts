import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectModule, nativeFacts } from './prepare-module-inputs';
import { verifyProducerSourceArchive } from '../../../packages/xpod-cli/src/producer-source';

// Inspect the serialized package, never trust a separately built directory.
const scan = `import tarfile,json,hashlib,pathlib,sys,re
seen=set();files={};documents={}
with tarfile.open(sys.argv[1],'r|gz') as tar:
 for m in tar:
  n=m.name.rstrip('/')
  if n in seen or not (n=='package' or n.startswith('package/')) or any(p in ['.','..',''] for p in n.split('/')) or re.search(r'[\\x00-\\x1f\\\\:]',n):raise ValueError('unsafe or duplicate product member')
  seen.add(n)
  if m.isdir():continue
  if not m.isfile():raise ValueError('nonregular product member')
  b=tar.extractfile(m).read();name=n[8:]
  if len(b)!=m.size:raise ValueError('truncated product member')
  files[name]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'mode':m.mode&511}
  if name in ['package.json','dist/producer-materials/index.json','provenance/native-build.receipt.json','provenance/native-source-kit.json']:
   documents[name]=json.loads(b)
  if name.startswith('dist/producer-materials/'):
   out=pathlib.Path(sys.argv[2])/name;out.parent.mkdir(parents=True,exist_ok=True)
   with out.open('xb') as f:f.write(b)
print(json.dumps({'files':files,'documents':documents}))`;
type FileFact = { bytes: number; sha256: string; mode: number };
export function scanProduct(archive: string, directory: string): { files: Record<string, FileFact>; documents: Record<string, any> } {
  if (lstatSync(archive).isSymbolicLink() || !lstatSync(archive).isFile()) throw new Error('regular product archive required');
  return JSON.parse(execFileSync('python3', ['-c', scan, archive, directory], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const producerScope = 'Package source snapshot only; no claim of release acceptance or dependency closure.';
const buildCommands = ['bun run build:packages', 'bun packages/xpod-afs/scripts/build-package.ts', 'bun build module-admission.ts --target=node --format=esm'];
export function projectProductBuild(build: any, sourceSHA: string) {
  const keys = ['sourceSHA', 'sourceClean', 'exit', 'coreSHA256', 'driverSHA256', 'commands', 'metafiles'];
  if (!build || Object.keys(build).some(key => !keys.includes(key)) || build.sourceSHA !== sourceSHA
    || build.sourceClean !== true || build.exit !== 0 || !Array.isArray(build.commands)
    || JSON.stringify(build.commands) !== JSON.stringify(buildCommands)
    || typeof build.coreSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(build.coreSHA256)
    || typeof build.driverSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(build.driverSHA256)) throw new Error('invalid product build receipt');
  return { sourceSHA, sourceClean: true, exit: 0, coreSHA256: build.coreSHA256, driverSHA256: build.driverSHA256, commands: [...buildCommands] };
}
export async function validateCliProduct(archive: string, directory: string, sourceSHA: string, coreSHA256: string, expected: any) {
  const { files, documents } = scanProduct(archive, directory);
  const manifest = documents['package.json'];
  if (manifest?.name !== '@undefineds.co/xpod-cli' || manifest.version !== expected.version
    || JSON.stringify(manifest.bin) !== JSON.stringify(expected.bin) || manifest.bin?.xpod !== './dist/bin/xpod'
    || JSON.stringify(manifest.exports) !== JSON.stringify(expected.exports)) throw new Error('CLI public manifest mismatch');
  const required = ['dist/xpod.mjs', 'dist/bin/xpod', 'LICENSE', 'README.md'];
  for (const name of ['./client', './build-tools']) {
    for (const field of ['types', 'import', 'require']) {
      const member = manifest.exports[name]?.[field];
      if (typeof member !== 'string' || !member.startsWith('./')) throw new Error('missing public CLI export');
      required.push(member.slice(2));
    }
  }
  if (manifest.exports['./producer-materials'] !== './dist/producer-materials/index.json') throw new Error('producer export mismatch');
  required.push('dist/producer-materials/index.json');
  if (required.some(name => !files[name]) || files['dist/xpod.mjs'].sha256 !== coreSHA256 || !(files['dist/bin/xpod'].mode & 0o111)) throw new Error('public CLI payload mismatch');
  const producer = documents['dist/producer-materials/index.json'];
  if (producer?.sourceAuthority?.sourceCommit !== sourceSHA || producer.sourceAuthority.dirty !== false
    || producer.producer?.name !== manifest.name || producer.producer.version !== manifest.version) throw new Error('CLI producer source mismatch');
  const authority = producer.sourceAuthority;
  if (Object.keys(authority).some(key => !['sourceCommit', 'dirty', 'snapshotSHA256', 'scope'].includes(key))
    || typeof authority.snapshotSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(authority.snapshotSHA256)
    || authority.scope !== producerScope) throw new Error('invalid producer source authority');
  const prefix = 'dist/producer-materials/'; const names = new Set<string>();
  if (!Array.isArray(producer.files) || !producer.files.length) throw new Error('missing producer inventory');
  for (const file of producer.files) {
    const actual = files[prefix + file.path];
    if (names.has(file.path) || !actual || actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('producer material mismatch');
    names.add(file.path);
  }
  if (Object.keys(files).some(name => name.startsWith(prefix) && name !== prefix + 'index.json' && !names.has(name.slice(prefix.length)))) throw new Error('unlisted producer material');
  const root = path.join(directory, prefix);
  // Exact public source archive membership/bytes uses the canonical verifier.
  for (const field of ['clientSource', 'sourceInventory']) if (!names.has(producer[field])) throw new Error('unbound producer source');
  await verifyProducerSourceArchive({ archive: path.join(root, producer.clientSource), inventory: path.join(root, producer.sourceInventory) });
  for (const [kind, member] of [['cjs', 'dist/client.cjs'], ['esm', 'dist/client.mjs']]) {
    if (producer.clientPayloads?.[kind + 'SHA256'] !== files[member].sha256) throw new Error('producer client binding mismatch');
  }
  return { name: manifest.name, version: manifest.version, exports: manifest.exports, bin: manifest.bin, files,
    producerSourceAuthority: { sourceCommit: sourceSHA, dirty: false, snapshotSHA256: authority.snapshotSHA256, scope: producerScope } };
}

export async function exportProducts(workspace: string, moduleArchive: string, cliArchive: string, nativeArchive: string, target: string, sourceSHA: string, buildReceipt: string, out: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSHA) || git('rev-parse', 'HEAD') !== sourceSHA || git('status', '--porcelain', '--untracked-files=all')) throw new Error('immutable clean product source required');
  const build = JSON.parse(readFileSync(buildReceipt, 'utf8'));
  const safeBuild = projectProductBuild(build, sourceSHA);
  const tempParent = path.join(workspace, '.test-data/product-export-validation'); mkdirSync(tempParent, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(path.join(tempParent, 'case-'));
  try {
    const originalHashes = [moduleArchive, cliArchive].map(file => hash(readFileSync(file)));
    const authority = nativeFacts(target);
    if (lstatSync(nativeArchive).isSymbolicLink() || hash(readFileSync(nativeArchive)) !== authority.zipSHA256) throw new Error('unbound original native artifact');
    const original = JSON.parse(execFileSync('python3', ['-c', "import zipfile,hashlib,json,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in ['native-receipt.json','source-kit.json']}))", nativeArchive], { encoding: 'utf8' }));
    const module = scanProduct(moduleArchive, path.join(temp, 'module'));
    const nativeReceipt = original['native-receipt.json'];
    const nativeKit = original['source-kit.json'];
    if (!nativeReceipt || !nativeKit) throw new Error('missing product native provenance');
    const afs = collectModule(moduleArchive, target, sourceSHA, nativeReceipt, nativeKit);
    const cli = await validateCliProduct(cliArchive, path.join(temp, 'cli'), sourceSHA, build.coreSHA256, JSON.parse(readFileSync(path.join(workspace, 'packages/xpod-cli/package.json'), 'utf8')));
    const event = process.env.GITHUB_EVENT_NAME ?? null;
    const githubSHA = process.env.GITHUB_SHA ?? null;
    const eventDocument = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const eventHeadSHA = eventDocument.after ?? null;
    if (githubSHA !== sourceSHA || event !== 'workflow_dispatch' && event !== 'push'
      || event === 'push' && eventHeadSHA !== sourceSHA) throw new Error('unsupported product source event');
    const records = [
      { filename: 'afs.tgz', original: moduleArchive, metadata: { ...afs, files: module.files } },
      { filename: 'cli.tgz', original: cliArchive, metadata: cli },
    ].map(({ filename, original, metadata }, index) => {
      const bytes = readFileSync(original);
      if (hash(bytes) !== originalHashes[index]) throw new Error('product archive changed during validation');
      return { filename, bytes: bytes.length, sha256: hash(bytes), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata, payload: bytes };
    });
    if (git('rev-parse', 'HEAD') !== sourceSHA || git('status', '--porcelain', '--untracked-files=all')) throw new Error('product source changed during validation');
    mkdirSync(out, { mode: 0o700 });
    for (const record of records) writeFileSync(path.join(out, record.filename), record.payload, { flag: 'wx', mode: 0o600 });
    const inventory = { schemaVersion: 1, scope: 'Exact product materials; no publication or license clearance', actualGitSHA: sourceSHA, githubSHA, event,
      eventHeadSHA, ref: process.env.GITHUB_REF, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
      sourceClean: true, target, nativeBuildSourceSHA: authority.source, originalNativeZIP_SHA256: authority.zipSHA256,
      originalNativeReceiptSHA256: nativeReceipt, originalNativeSourceKitSHA256: nativeKit, buildReceiptSHA256: hash(readFileSync(buildReceipt)),
      build: safeBuild,
      files: records.map(({ payload, ...record }) => record) };
    writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const option = (key: string) => { const i = args.indexOf(key); if (i < 0 || !args[i + 1]) throw new Error('missing product argument'); return args[i + 1]; };
  await exportProducts(path.resolve(option('--workspace')), path.resolve(option('--module')), path.resolve(option('--cli')), path.resolve(option('--native-archive')), option('--target'), option('--source-sha'), path.resolve(option('--build-receipt')), path.resolve(option('--out')));
}
