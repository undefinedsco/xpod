import { lstatSync, openSync, readSync, closeSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { safeMaterialPath, sourceFileIndex, type SourceFile } from '../../packages/xpod-cli/src/source-materials';

/** Original SourceFile shape and native/source-kit field casing are preserved. */
export type NativeFile = SourceFile;
export interface LocalNativeStage { kind: 'local'; receipt: NativeFile; raw: NativeFile }
export interface OfficialNativeStage {
  kind: 'github'; run: NativeFile; job: NativeFile; artifact: NativeFile;
  archive: NativeFile; raw: NativeFile; sourceCommit: string;
}
export type NativeStage = LocalNativeStage | OfficialNativeStage;
export interface NativeMaterialBinding {
  binary: NativeFile; target: string; sourceKit: NativeFile; sourceRoot: string;
  nativeReceipt: NativeFile; patches: NativeFile[]; terms: NativeFile[];
  toolchainInputs: NativeFile[]; compilerBindings: { field: string; file: NativeFile }[];
  inputObservation: NativeFile; observationStage: NativeStage;
  buildStage: NativeStage; testStage: NativeStage;
}
export interface NativeMaterialIndex {
  schemaVersion: 1; status: 'native-build-materials'; bindings: NativeMaterialBinding[];
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native material object');
  return value as Record<string, any>;
}
function keys(value: unknown, allowed: string[]): Record<string, any> {
  const row = object(value);
  if (Object.keys(row).some(key => !allowed.includes(key)) || allowed.some(key => !(key in row))) throw new Error('Unexpected or absent native material fields');
  return row;
}
function file(root: string, value: unknown): { ref: NativeFile; bytes: Buffer; absolute: string } {
  const row = keys(value, ['path', 'sha256', 'sizeBytes']);
  sourceFileIndex([row as NativeFile]);
  let absolute = path.resolve(root);
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) throw new Error('Unsafe native material root');
  for (const part of row.path.split('/')) {
    absolute = path.join(absolute, part);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error('Native material symlink rejected');
  }
  if (!lstatSync(absolute).isFile()) throw new Error('Native material is not regular');
  const bytes = readFileSync(absolute);
  if (bytes.length !== row.sizeBytes || sha(bytes) !== row.sha256) throw new Error('Native material bytes/hash mismatch');
  return { ref: row as NativeFile, bytes, absolute };
}
function directory(root: string, relative: string): string {
  if (!safeMaterialPath(relative) || lstatSync(root).isSymbolicLink()) throw new Error('Unsafe native source directory');
  let current = path.resolve(root);
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('Native source directory symlink/non-directory');
  }
  return current;
}
function sourceMembers(root: string, relative = ''): string[] {
  const members: string[] = [];
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const next = relative ? relative + '/' + name : name, stat = lstatSync(path.join(root, next));
    if (!safeMaterialPath(next) || stat.isSymbolicLink()) throw new Error('Unsafe original native source member');
    if (stat.isDirectory()) members.push(...sourceMembers(root, next));
    else if (stat.isFile()) members.push(next);
    else throw new Error('Original native source member not regular');
  }
  return members;
}
function json(root: string, ref: unknown): Record<string, any> { return object(JSON.parse(file(root, ref).bytes.toString('utf8'))); }
function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
function stage(root: string, value: unknown): Buffer {
  const row = object(value);
  if (row.kind === 'local') {
    keys(row, ['kind', 'receipt', 'raw']);
    const receipt = json(root, row.receipt), raw = file(root, row.raw).bytes;
    if (receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null || receipt.rawClosedBeforeHash !== true || receipt.ownedGroupAbsentAfterWait !== true ||
        typeof receipt.closedUTC !== 'string' || !Number.isFinite(Date.parse(receipt.closedUTC)) || receipt.resourceStop !== null || receipt.supervisorError !== null ||
        !Array.isArray(receipt.cleanupErrors) || receipt.cleanupErrors.length || receipt.rawSHA256 !== sha(raw) || !Array.isArray(receipt.command) || !receipt.command.length || receipt.command.some((v: unknown) => typeof v !== 'string')) {
      throw new Error('Native local stage is not successfully closed/raw-bound');
    }
    return raw;
  }
  if (row.kind === 'github') {
    keys(row, ['kind', 'run', 'job', 'artifact', 'archive', 'raw', 'sourceCommit']);
    const run = json(root, row.run), job = json(root, row.job), artifact = json(root, row.artifact);
    const archive = file(root, row.archive), raw = file(root, row.raw);
    if (!/^[a-f0-9]{40}$/u.test(row.sourceCommit) || !Number.isSafeInteger(run.id) || run.id <= 0 || run.status !== 'completed' || run.conclusion !== 'success' || run.head_sha !== row.sourceCommit ||
        job.run_id !== run.id || !Number.isSafeInteger(job.id) || job.id <= 0 || job.status !== 'completed' || job.conclusion !== 'success' ||
        !Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired !== false || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== row.sourceCommit ||
        artifact.digest !== 'sha256:' + archive.ref.sha256 || !raw.bytes.length) throw new Error('Official native run/job/artifact material binding mismatch');
    // Stored API bodies and download bytes are internally checked; fresh official
    // collection, ZIP membership/log provenance and signature trust remain central admission responsibilities.
    return raw.bytes;
  }
  throw new Error('Unsupported native stage provenance kind');
}
/** Carried material targets are separate from CLI product-platform support. No execution. */
export function verifyNativeMaterialTarget(bytes: Buffer, target: string): void {
  function fail(): never { throw new Error('Native material format/target mismatch'); }
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '0061736d') {
    if (target !== 'portable-wasm' || bytes.length < 8 || bytes.readUInt32LE(4) !== 1 || !WebAssembly.validate(new Uint8Array(bytes))) fail();
    return;
  }
  if (magic === '7f454c46') {
    if (bytes.length < 52 || ![1, 2].includes(bytes[4]) || ![1, 2].includes(bytes[5]) || bytes[6] !== 1) fail();
    const little = bytes[5] === 1, u16 = (offset: number) => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    const machine = u16(18), arch = ({ 3: 'ia32', 40: 'arm', 62: 'x64', 183: 'arm64', 243: 'riscv64' } as Record<number, string>)[machine];
    const headerSize = bytes[4] === 2 ? 64 : 52;
    const version = little ? bytes.readUInt32LE(20) : bytes.readUInt32BE(20);
    if (version !== 1) fail();
    if (!arch || target !== 'linux-' + arch || bytes.length < headerSize || u16(bytes[4] === 2 ? 52 : 40) !== headerSize || ![1, 2, 3].includes(u16(16)) || ((['x64', 'arm64', 'riscv64'].includes(arch) ? 2 : 1) !== bytes[4])) fail();
    return;
  }
  const machArch = (cpu: number): string | undefined => ({ 7: 'ia32', 12: 'arm', 0x01000007: 'x64', 0x0100000c: 'arm64' } as Record<number, string>)[cpu];
  if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic)) {
    const little = magic.startsWith('cefa') || magic.startsWith('cffa'), wide = magic === 'feedfacf' || magic === 'cffaedfe';
    const u32 = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset), size = wide ? 32 : 28;
    if (bytes.length < size) fail();
    const arch = machArch(u32(4));
    if (!arch || target !== 'darwin-' + arch || wide !== ['x64', 'arm64'].includes(arch) || ![1, 2, 6, 8, 9, 11, 12].includes(u32(12)) || u32(20) > bytes.length - size) fail();
    let cursor = size;
    for (let i = 0; i < u32(16); i++) { if (cursor + 8 > size + u32(20)) fail(); const commandSize = u32(cursor + 4); if (commandSize < 8 || commandSize % 4 || cursor + commandSize > size + u32(20)) fail(); cursor += commandSize; }
    if (cursor !== size + u32(20)) fail(); return;
  }
  if (['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) {
    const little = magic === 'bebafeca' || magic === 'bfbafeca', wide = magic === 'cafebabf' || magic === 'bfbafeca';
    const u32 = (offset: number) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    if (target !== 'darwin-universal' || bytes.length < 8) fail();
    const count = u32(4), recordSize = wide ? 32 : 20, tableEnd = 8 + count * recordSize;
    if (count < 2 || count > 16 || tableEnd > bytes.length) fail();
    const ranges: { start: number; end: number }[] = [], arches = new Set<string>();
    for (let i = 0; i < count; i++) {
      const at = 8 + i * recordSize, arch = machArch(u32(at));
      const number64 = (offset: number) => { const value = little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset); if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(value); };
      const start = wide ? number64(at + 8) : u32(at + 8), length = wide ? number64(at + 16) : u32(at + 12), alignment = u32(at + (wide ? 24 : 16));
      if (!arch || arches.has(arch) || start < tableEnd || !length || start + length > bytes.length || alignment > 31 || start % (2 ** alignment) || ranges.some(r => start < r.end && start + length > r.start)) fail();
      verifyNativeMaterialTarget(bytes.subarray(start, start + length), 'darwin-' + arch); arches.add(arch); ranges.push({ start, end: start + length });
    } return;
  }
  if (bytes.subarray(0, 2).toString() === 'MZ') {
    if (bytes.length < 64) fail(); const pe = bytes.readUInt32LE(60);
    if (pe < 64 || pe + 24 > bytes.length || bytes.subarray(pe, pe + 4).toString('hex') !== '50450000') fail();
    const arch = ({ 0x014c: 'ia32', 0x01c4: 'arm', 0x8664: 'x64', 0xaa64: 'arm64' } as Record<number, string>)[bytes.readUInt16LE(pe + 4)];
    const sections = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), optional = pe + 24, table = optional + optionalSize;
    if (!arch || target !== 'win32-' + arch || !sections || sections > 96 || optionalSize < 2 || table + sections * 40 > bytes.length || bytes.readUInt16LE(optional) !== (['x64', 'arm64'].includes(arch) ? 0x20b : 0x10b)) fail();
    for (let i = 0; i < sections; i++) { const at = table + i * 40, length = bytes.readUInt32LE(at + 16), start = bytes.readUInt32LE(at + 20); if (length && (start < table + sections * 40 || start + length > bytes.length)) fail(); }
    return;
  }
  fail();
}
/** Scan actual runtime bytes; source/provenance are originals, not runtime inventory. */
export function physicalNativeInventory(root: string): NativeFile[] {
  const found: NativeFile[] = [];
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Unsafe native inventory root');
  const visit = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      if (!relative && ['source', 'provenance'].includes(name)) continue;
      const next = relative ? relative + '/' + name : name, absolute = path.join(root, next), stat = lstatSync(absolute);
      if (!safeMaterialPath(next) || stat.isSymbolicLink()) throw new Error('Unsafe native runtime member');
      if (stat.isDirectory()) visit(next);
      else if (stat.isFile()) {
        const header = Buffer.alloc(4), fd = openSync(absolute, 'r');
        let size: number; try { size = readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
        if (size >= 2 && (['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca', '0061736d'].includes(header.toString('hex')) || header.subarray(0, 2).toString() === 'MZ')) {
          const bytes = readFileSync(absolute); found.push({ path: next, sha256: sha(bytes), sizeBytes: bytes.length });
        }
      } else throw new Error('Native runtime member is not regular');
    }
  }; visit(''); return found;
}
/** Integrity/relationship validation only: no native execution, source authentication or release clearance. */
export function verifyPhysicalNativeMaterials(productRoot: string, options: { materialsRoot: string; indexPath?: string }): { binaries: NativeFile[]; status: 'material-integrity-verified'; externalAdmission: 'pending' } {
  if (!options || typeof options.materialsRoot !== 'string' || !options.materialsRoot) throw new Error('Explicit external native materials root required');
  const physicalRoot = (value: string): string => {
    const absolute = path.resolve(value); let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('Native root ancestor symlink/non-directory');
    } return absolute;
  };
  const runtimeRoot = physicalRoot(productRoot), materialsRoot = physicalRoot(options.materialsRoot);
  const contains = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
  if (contains(runtimeRoot, materialsRoot) || contains(materialsRoot, runtimeRoot)) throw new Error('Product and native materials roots must be disjoint');
  const indexPath = options.indexPath ?? 'provenance/native/index.json';
  if (!safeMaterialPath(indexPath)) throw new Error('Unsafe native material index path');
  const indexDirectory = directory(runtimeRoot, path.posix.dirname(indexPath));
  // Runtime carries only the pre-frozen small binding index. Source/build/terms
  // and outer source-kit archives belong exclusively to the materials root.
  if (!same(sourceMembers(indexDirectory), [path.posix.basename(indexPath)])) throw new Error('Expanded native materials must not enter product inventory');
  const runtimeIndex = path.join(runtimeRoot, indexPath);
  if (lstatSync(runtimeIndex).isSymbolicLink() || !lstatSync(runtimeIndex).isFile()) throw new Error('Native index is not a regular original');
  const indexBytes = readFileSync(runtimeIndex);
  file(materialsRoot, { path: indexPath, sha256: sha(indexBytes), sizeBytes: indexBytes.length });
  const index = keys(JSON.parse(indexBytes.toString('utf8')), ['schemaVersion', 'status', 'bindings']);
  if (index.schemaVersion !== 1 || index.status !== 'native-build-materials' || !Array.isArray(index.bindings)) throw new Error('Invalid native build material index');
  const actual = physicalNativeInventory(runtimeRoot), seen = new Set<string>();
  const rejectProductOriginal = (relative: string): void => {
    if (!safeMaterialPath(relative)) throw new Error('Unsafe external native original path');
    let current = runtimeRoot;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('Product original material symlink rejected'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
    throw new Error('Original native materials must remain outside product inventory');
  };
  for (const value of index.bindings) {
    const row = keys(value, ['binary', 'target', 'sourceKit', 'sourceRoot', 'nativeReceipt', 'patches', 'terms', 'toolchainInputs', 'compilerBindings', 'inputObservation', 'observationStage', 'buildStage', 'testStage']);
    rejectProductOriginal(row.sourceRoot);
    for (const ref of [row.sourceKit, row.nativeReceipt, row.inputObservation]) { sourceFileIndex([ref]); rejectProductOriginal(ref.path); }
    for (const record of [row.buildStage, row.testStage, row.observationStage]) {
      const declared = object(record);
      for (const field of declared.kind === 'local' ? ['receipt', 'raw'] : ['run', 'job', 'artifact', 'archive', 'raw']) { sourceFileIndex([declared[field]]); rejectProductOriginal(declared[field].path); }
    }
    const binary = file(runtimeRoot, row.binary);
    if (seen.has(binary.ref.path) || !actual.some(f => same(f, binary.ref))) throw new Error('Duplicate or non-native binary binding');
    seen.add(binary.ref.path); verifyNativeMaterialTarget(binary.bytes, row.target);
    if (!safeMaterialPath(row.sourceRoot) || !row.sourceRoot.startsWith('provenance/')) throw new Error('Unsafe native source material root');
    const sourceRoot = directory(materialsRoot, row.sourceRoot), kit = json(materialsRoot, row.sourceKit), receipt = json(materialsRoot, row.nativeReceipt);
    if (kit.schemaVersion !== 1 || kit.status !== 'native-source-materials' || typeof kit.toolchain !== 'string' || !kit.toolchain || !/^[a-f0-9]{40}$/u.test(kit.engine?.commit) ||
        typeof kit.engine.repository !== 'string' || !kit.engine.repository.startsWith('https://') || !Array.isArray(kit.files) || !kit.files.length) throw new Error('Invalid original native source kit');
    const sourceFiles = sourceFileIndex(kit.files);
    for (const ref of kit.files) file(sourceRoot, ref);
    const kitRelative = path.relative(sourceRoot, file(materialsRoot, row.sourceKit).absolute).split(path.sep).join('/');
    const actualSource = sourceMembers(sourceRoot).filter(name => name !== kitRelative);
    if (!same(actualSource.sort(), [...sourceFiles.keys()].sort())) throw new Error('Native source-kit inventory is incomplete');
    const repository = new URL(kit.engine.repository);
    if (repository.protocol !== 'https:' || repository.username || repository.password) throw new Error('Unsafe native repository authority');
    for (const [role, required] of [['patches', false], ['terms', true], ['toolchainInputs', true]] as const) {
      if (!Array.isArray(row[role]) || (required && !row[role].length)) throw new Error('Native original material role missing');
      sourceFileIndex(row[role]);
      for (const ref of row[role]) if (ref.sizeBytes === 0 || !kit.files.some((f: NativeFile) => same(f, ref))) throw new Error('Native original role not bound to source-kit inventory');
    }
    const nonSource = new Set([...row.patches, ...row.terms, ...row.toolchainInputs].map((f: NativeFile) => f.path));
    if (!kit.files.some((f: NativeFile) => !nonSource.has(f.path) && f.sizeBytes > 0)) throw new Error('Actual native source inputs missing');
    if (!Array.isArray(row.compilerBindings) || !row.compilerBindings.length) throw new Error('Actual compiler material binding missing');
    const fields = new Set<string>();
    for (const binding of row.compilerBindings) {
      keys(binding, ['field', 'file']);
      if (typeof binding.field !== 'string' || !/^[A-Za-z][A-Za-z0-9]*Sha256$/u.test(binding.field) || fields.has(binding.field) || !row.toolchainInputs.some((f: NativeFile) => same(f, binding.file)) || receipt.compiler?.[binding.field] !== binding.file.sha256) throw new Error('Compiler/source toolchain binding mismatch');
      fields.add(binding.field);
    }
    if (receipt.schemaVersion !== 1 || receipt.target !== row.target || !same(receipt.engine, kit.engine) || receipt.sourceKitSha256 !== row.sourceKit.sha256 || receipt.helperSha256 !== binary.ref.sha256 || receipt.compiler?.toolchain !== kit.toolchain || receipt.testsPassed !== true || !Array.isArray(receipt.buildArguments) || !receipt.buildArguments.length || receipt.buildArguments.some((v: unknown) => typeof v !== 'string') || receipt.stagedVerifiedFilesOnly !== true || receipt.sourceFiles !== sourceFiles.size) throw new Error('Native build receipt source/input/binary mismatch');
    const observation = json(materialsRoot, row.inputObservation);
    if (observation.schemaVersion !== 1 || observation.target !== row.target || observation.sourceKitSha256 !== row.sourceKit.sha256 || observation.helperSha256 !== binary.ref.sha256 || !same(observation.filesBefore, kit.files) || !same(observation.filesAfter, kit.files)) throw new Error('Native build source before/after observation mismatch');
    const observedRaw = stage(materialsRoot, row.observationStage);
    let observed: unknown; try { observed = JSON.parse(observedRaw.toString('utf8')); } catch { throw new Error('Native input observation raw output is not JSON'); }
    if (!same(observed, observation)) throw new Error('Native input observation differs from closed raw output');
    stage(materialsRoot, row.buildStage); stage(materialsRoot, row.testStage);
    const rawPaths = [row.buildStage.raw.path, row.testStage.raw.path, row.observationStage.raw.path];
    if (new Set(rawPaths).size !== 3) throw new Error('Distinct native raw stage records required');
    if (same(row.buildStage, row.testStage) || same(row.buildStage, row.observationStage) || same(row.testStage, row.observationStage)) throw new Error('Distinct native build/test/input stages required');
  }
  if (seen.size !== actual.length) throw new Error('Actual native inventory has uncovered members');
  return { binaries: actual, status: 'material-integrity-verified', externalAdmission: 'pending' };
}
