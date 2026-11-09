import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { NativeFile } from '../physical-module-native';

export const LINUX_QLEVER_REVIEWED_FILES = Object.freeze([
  {
    "path": "qlever/scripts/produce-linux-runtime-archive.py",
    "sha256": "1401a84252c729647998ecd86885d9a36ca70305c9085e347e8cb2fc0747b34e"
  },
  {
    "path": "qlever/scripts/prepare-linux-physical-runtime.py",
    "sha256": "82bad3c59736f144b1a7e5e176edfb997a90026fc20d6aabd839339cff00504e"
  },
  {
    "path": "qlever/scripts/build-module-runtime-sdk.sh",
    "sha256": "1b36fba0f08a7e27aaedac7ca34e1f33584a8802160cc7d2cf30f7ba179ebcbf"
  },
  {
    "path": "qlever/scripts/build-qlever-runtime-sdk.sh",
    "sha256": "52d63b01f2689076acbb795a8c772bbeeedb4785341430d7408aa91aa77d9385"
  },
  {
    "path": "qlever/scripts/qlever_compiler_profile.py",
    "sha256": "3a3bcaf7e20cdee078489d97af51d6cb5e522600fb581430fc52eecd15d284f4"
  },
  {
    "path": "qlever/scripts/run-focused-native-build.sh",
    "sha256": "e7f153d2b3adc7bb489576b48b113a36114454520848d3e094b20c1e6dd495e4"
  },
  {
    "path": "qlever/scripts/validate-prior-sdk.py",
    "sha256": "273c4df73370fd6df1d7c2fd28382a7f7f11e9d8ec091c55c8b72e087aa11eb7"
  },
  {
    "path": "qlever/scripts/verify-local-runtime-artifacts.py",
    "sha256": "b95365f0736f531d772a394a9936911ae9d843b616f6c933030845102bf4efdf"
  },
  {
    "path": "docker/qlever-runtime-sdk/Dockerfile.module-bookworm",
    "sha256": "3f5e522f15826663e65f49f388f7ae17188b67b5ebcee36373faa74321fedc40"
  },
  {
    "path": "docker/qlever-local-runtime/Dockerfile.module-bookworm",
    "sha256": "d4c6308caf494272abe933d288ce154e3f7d34b9a4c5b36af579af893ec86d1a"
  }
].map(row => Object.freeze(row)));
function fail(reason: string): never { throw Error('Linux QLever runtime originals: ' + reason); }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safe = (name: string) => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const SHA = /^[a-f0-9]{64}$/u;
const SYSTEM = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'librt.so.1', 'libdl.so.2', 'ld-linux-x86-64.so.2', 'ld-linux-aarch64.so.1']);
export interface LinuxNativeRanges { readonly reference: Readonly<NativeFile>; readRange(offset: number, length: number): Buffer }
/** Bounded declarations from actual 64-bit ELF bytes; no execution or issuer. */
export function observeLinuxElfRanges(input: LinuxNativeRanges, target: string) {
  if (!['linux-x64', 'linux-arm64'].includes(target)) fail('unsupported native target');
  const read = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > input.reference.sizeBytes) fail('ELF range budget');
    const bytes = input.readRange(offset, length); if (bytes.length !== length) fail('ELF range truncated'); return bytes;
  };
  const integer = (value: bigint) => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('ELF integer range'); return Number(value); };
  const header = read(0, 64);
  if (header.toString('hex', 0, 7) !== '7f454c46020101' || ![2, 3].includes(header.readUInt16LE(16))
    || header.readUInt16LE(18) !== (target === 'linux-x64' ? 62 : 183) || header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) fail('ELF target/header mismatch');
  const phoff = integer(header.readBigUInt64LE(32)), count = header.readUInt16LE(56);
  if (!count || count > 128 || header.readUInt16LE(54) !== 56) fail('ELF program header budget');
  const segments: { type: number; offset: number; address: number; bytes: number }[] = [];
  let interpreter: string | undefined;
  for (let i = 0; i < count; i++) {
    const row = read(phoff + i * 56, 56), segment = { type: row.readUInt32LE(0), offset: integer(row.readBigUInt64LE(8)), address: integer(row.readBigUInt64LE(16)), bytes: integer(row.readBigUInt64LE(32)) };
    if (segment.offset + segment.bytes > input.reference.sizeBytes) fail('ELF segment outside original');
    segments.push(segment);
    if (segment.type === 3) {
      if (interpreter || segment.bytes < 2 || segment.bytes > 256) fail('ELF interpreter budget');
      const value = read(segment.offset, segment.bytes); if (value.at(-1) !== 0) fail('ELF interpreter terminator'); interpreter = value.subarray(0, -1).toString();
      if (interpreter !== (target === 'linux-x64' ? '/lib64/ld-linux-x86-64.so.2' : '/lib/ld-linux-aarch64.so.1')) fail('ELF interpreter target mismatch');
    }
  }
  const dynamic = segments.filter(row => row.type === 2);
  if (dynamic.length !== 1 || dynamic[0]!.bytes > 65536 || dynamic[0]!.bytes % 16) fail('ELF dynamic table budget');
  const values = new Map<number, number[]>(); let ended = false;
  for (let i = 0; i < dynamic[0]!.bytes; i += 16) {
    const row = read(dynamic[0]!.offset + i, 16), tag = integer(row.readBigUInt64LE(0));
    if (tag === 0) { ended = true; break; }
    if ([0x7fffffff, 0x7ffffffd, 0x6ffffefc, 0x6ffffefb].includes(tag)) fail('unsupported ELF loader filter/audit scope');
    if ([1, 5, 10, 14, 15, 29].includes(tag)) values.set(tag, [...(values.get(tag) ?? []), integer(row.readBigUInt64LE(8))]);
  }
  const address = values.get(5), lengths = values.get(10);
  if (!ended || address?.length !== 1 || lengths?.length !== 1 || !lengths[0] || lengths[0] > 4 * 1024 ** 2) fail('ELF string table missing/budget');
  const load = segments.find(row => row.type === 1 && address[0]! >= row.address && address[0]! + lengths[0]! <= row.address + row.bytes);
  if (!load) fail('ELF string table outside file-backed load');
  const string = (offset: number) => {
    if (offset < 0 || offset >= lengths[0]!) fail('ELF string offset');
    const bytes = read(load.offset + address[0]! - load.address + offset, Math.min(4096, lengths[0]! - offset));
    const end = bytes.indexOf(0); if (end < 0) fail('ELF bounded string terminator'); return bytes.subarray(0, end).toString();
  };
  const needed = (values.get(1) ?? []).map(string), rpaths = [...(values.get(15) ?? []), ...(values.get(29) ?? [])].map(string), sonames = (values.get(14) ?? []).map(string);
  if (needed.length > 128 || new Set(needed).size !== needed.length || needed.some(name => !/^[A-Za-z0-9_.+-]+$/u.test(name)) || sonames.length > 1 || rpaths.length !== 1) fail('ELF dependency/loader path declaration');
  return Object.freeze({ needed: Object.freeze(needed), rpath: rpaths[0]!, interpreter, soname: sonames[0] });
}
interface Ref { path: string; bytes: number; sha256: string }
interface StageReceipt {
  command: string[]; actualWait: boolean; exit: number; signal: unknown; ownedGroupAbsentAfterWait: boolean; rawClosedBeforeHash: boolean;
  resourceStop: unknown; supervisorError: unknown; ownedGroupMembers: unknown[]; cleanupErrors: unknown[]; rawSHA256: string; startedUTC: string; closedUTC: string;
}
interface Manifest {
  schemaVersion: number; adapterAbiVersion: number; physicalBackendAbiVersion: number; qlever: { repository: string; commit: string; patchSeriesSha256: string };
  build: { source: string; platform?: string; entrypoint: string; priorSdkImage?: string }; artifacts: { path: string; size: number; sha256: string }[];
}
interface Image { id: string; os: string; architecture: string; repoDigests: string[] }
interface Final {
  schemaVersion: number; status: string; releaseAccepted: boolean; target: string; sourceSha: string; runId: string; runAttempt: string;
  sdkImage: string; runtimeImage: string; images: { sdk: Image; runtime: Image }; archive: Ref; files: Ref[];
  stages: Record<string, { receiptSha256: string; rawSha256: string }>;
  compilerProfile: Record<string, unknown>; runtimeBinarySha256: string; physicalManifestSha256: string; originalManifestSha256: string; abiReceiptSha256: string;
}
interface Physical {
  schemaVersion: number; target: string; ok: boolean; failure: unknown; releaseAccepted: boolean; originalManifestSHA256: string;
  toolInputs: Record<string, { path: string; sha256: string }>;
  commands: { command: string[]; actualExit: number; actualWait: boolean; rawClosed: boolean; stdoutSHA256: string; stderrSHA256: string }[];
  files: Ref[]; originalBindings: { original: string; path: string; originalSHA256: string; originalBytes: number }[];
}
export interface LinuxQleverRuntimeOriginalInput {
  readonly target: string; readonly final: Buffer; readonly manifest: Buffer;
  readonly qleverLock: Buffer; readonly physicalAbiHeader: Buffer;
  readonly reviewedFiles: ReadonlyMap<string, Buffer>;
  readonly members: ReadonlyMap<string, LinuxNativeRanges>;
  readonly originalInventory: readonly Readonly<NativeFile>[];
  readOriginal(reference: Readonly<NativeFile>, maximumBytes: number): Buffer;
  readonly jobWindow: { startedUTC: string; closedUTC: string };
}
/** One mechanical axis. Surrounding issuer must pair independently collected
 * product/native/Git origins and actual tar membership; this function issues no
 * capability and never equates extraction receipts with original SDK builds. */
export function verifyLinuxQleverRuntimeOriginals(input: LinuxQleverRuntimeOriginalInput) {
  const inventory = new Map(input.originalInventory.map(row => [row.path, row]));
  if (inventory.size !== input.originalInventory.length || inventory.size > 40000) fail('original inventory budget/duplicate');
  const read = (name: string, maximum = 1024 ** 2) => {
    const row = inventory.get(name);
    if (!safe(name) || !row || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > maximum || maximum > 8 * 1024 ** 2 || !SHA.test(row.sha256)) fail('bounded original required: ' + name);
    const bytes = input.readOriginal(row, maximum);
    if (bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256) fail('original bytes changed: ' + name); return bytes;
  };
  const json = <T>(name: string): T => JSON.parse(read(name).toString()) as T;
  for (const row of LINUX_QLEVER_REVIEWED_FILES) if (!input.reviewedFiles.has(row.path) || hash(input.reviewedFiles.get(row.path)!) !== row.sha256) fail('unreviewed immutable recipe: ' + row.path);
  if (!read('native-build-materials.json', 8 * 1024 ** 2).equals(input.final)) fail('native result original differs');
  const final = JSON.parse(input.final.toString()) as Final;
  if (!['linux-x64', 'linux-arm64'].includes(input.target) || final.schemaVersion !== 1 || final.status !== 'native-build-test-materials' || final.releaseAccepted !== false
    || final.target !== input.target || !/^[a-f0-9]{40}$/u.test(final.sourceSha) || !/^[1-9][0-9]*$/u.test(String(final.runId)) || !/^[1-9][0-9]*$/u.test(String(final.runAttempt))) fail('native result identity mismatch');
  if (!Array.isArray(final.files) || !final.files.length || final.files.length > 40000 || final.files.length + 1 !== inventory.size) fail('complete native original membership required');
  const seen = new Set<string>();
  for (const row of final.files) {
    const actual = inventory.get(row.path);
    if (!safe(row.path) || seen.has(row.path) || !actual || actual.sha256 !== row.sha256 || actual.sizeBytes !== row.bytes) fail('native final original inventory differs'); seen.add(row.path);
  }
  if (final.archive?.path !== `qlever-local-runtime-${input.target}.tar.gz` || inventory.get(final.archive.path)?.sha256 !== final.archive.sha256 || inventory.get(final.archive.path)?.sizeBytes !== final.archive.bytes) fail('actual native archive reference differs');
  const starts = Date.parse(input.jobWindow.startedUTC), closes = Date.parse(input.jobWindow.closedUTC);
  const stages = new Map<string, StageReceipt>();
  if (!Number.isFinite(starts) || !Number.isFinite(closes) || closes < starts || !final.stages || Object.keys(final.stages).length > 256) fail('native producer job window/stages');
  for (const [name, binding] of Object.entries(final.stages)) {
    if (!/^[a-z0-9-]+$/u.test(name)) fail('unsafe stage name');
    const receipt = json<StageReceipt>('stages/' + name + '.receipt.json'), raw = inventory.get('stages/' + name + '.raw.log');
    if (!raw || inventory.get('stages/' + name + '.receipt.json')?.sha256 !== binding.receiptSha256 || raw.sha256 !== binding.rawSha256 || receipt.rawSHA256 !== raw.sha256
      || receipt.actualWait !== true || receipt.exit !== 0 || receipt.signal !== null || receipt.ownedGroupAbsentAfterWait !== true || receipt.rawClosedBeforeHash !== true
      || receipt.resourceStop !== null || receipt.supervisorError !== null || !Array.isArray(receipt.ownedGroupMembers) || receipt.ownedGroupMembers.length
      || !Array.isArray(receipt.cleanupErrors) || receipt.cleanupErrors.length || !Array.isArray(receipt.command) || !receipt.command.length || receipt.command.some(item => typeof item !== 'string')) fail('actual stage closure/raw binding mismatch');
    stages.set(name, receipt);
  }
  let previous = starts;
  for (const stage of [...stages.values()].sort((a, b) => Date.parse(a.startedUTC) - Date.parse(b.startedUTC))) {
    const began = Date.parse(stage.startedUTC), ended = Date.parse(stage.closedUTC);
    if (!Number.isFinite(began) || !Number.isFinite(ended) || began < previous || ended < began || ended > closes) fail('stage outside original producer window'); previous = ended;
  }
  const command = (name: string, expected: string[]) => { if (!isDeepStrictEqual(stages.get(name)?.command, expected)) fail('canonical stage command required: ' + name); };
  command('source-head', ['git', 'rev-parse', 'HEAD']);
  const tracked = ['qlever','docker/qlever-runtime-sdk','docker/qlever-local-runtime','scripts/module-product-targets.ts','scripts/agentfs-native-ci','.dockerignore','.github/workflows/build-qlever-linux-runtime.yml','.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/publish-qlever-local-runtime.yml','.github/workflows/resolve-qlever-native-target.yml'];
  for (const name of ['source-clean', 'source-clean-after']) command(name, ['git', 'status', '--porcelain', '--untracked-files=all', '--', ...tracked]);
  for (const name of ['source-trees', 'source-trees-after']) command(name, ['git', 'ls-tree', 'HEAD', '--', ...tracked]);
  command('cpu-observation', ['lscpu', '--json']);
  const cpu = json<{ lscpu: { field: string; data: string }[] }>('stages/cpu-observation.raw.log');
  if (!Array.isArray(cpu.lscpu) || cpu.lscpu.find(row => row.field === 'Architecture:')?.data !== (input.target === 'linux-x64' ? 'x86_64' : 'aarch64')) fail('actual native CPU target differs');

  if (read('stages/source-head.raw.log').toString().trim() !== final.sourceSha || read('stages/source-clean.raw.log').length || read('stages/source-clean-after.raw.log').length
    || !read('stages/source-trees.raw.log').equals(read('stages/source-trees-after.raw.log'))) fail('actual source before/after differs');
  const prep = stages.get('physical-prepare')?.command;
  if (!prep || prep.length !== 46 || !/^\/[A-Za-z0-9_./-]+\.cid$/u.test(prep[4]!) || !/^\d+:\d+$/u.test(prep[23]!)
    || !/^type=bind,src=\/[^,\r\n]+,dst=\/original,readonly$/u.test(prep[27]!)
    || !/^type=bind,src=\/[^,\r\n]+,dst=\/out$/u.test(prep[29]!)
    || !/^type=bind,src=\/[^,\r\n]+,dst=\/workspace,readonly$/u.test(prep[31]!)) fail('owned physical preparation isolation required');
  command('physical-prepare', ['docker','run','--init','--cidfile',prep[4]!, '--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--entrypoint','/usr/bin/python3','--env','LD_PRELOAD=','--env','LD_LIBRARY_PATH=','--env','PYTHONPATH=','--env','PYTHONHOME=','--user',prep[23]!,
    '--tmpfs','/tmp:rw,nosuid,noexec,size=128m','--mount',prep[27]!, '--mount',prep[29]!, '--mount',prep[31]!,final.images.sdk.id,
    '/workspace/qlever/scripts/prepare-linux-physical-runtime.py','--source','/original','--out','/out/runtime','--evidence','/out/abi','--workspace','/workspace','--target',input.target,'--original-manifest-sha256',final.originalManifestSha256]);
  const arch = input.target === 'linux-x64' ? 'amd64' : 'arm64';
  for (const role of ['sdk', 'runtime'] as const) {
    const reference = role === 'sdk' ? final.sdkImage : final.runtimeImage;
    const expectedRepository = 'ghcr.io/undefinedsco/xpod-qlever-' + (role === 'sdk' ? 'sdk' : 'local-runtime') + '-module-bookworm' + (input.target === 'linux-arm64' ? '-arm64' : '');
    if (!reference.startsWith(expectedRepository + '@sha256:') || !/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(reference)) fail('immutable image required');
    command(role + '-pull', ['docker', 'pull', '--platform', 'linux/' + arch, reference]);
    command(role + '-create', ['docker', 'create', final.images[role].id, 'true']);
    const cid = read('stages/' + role + '-create.raw.log').toString().trim();
    if (!/^[a-f0-9]{64}$/u.test(cid)) fail('owned extraction container identity missing');
    command(role + '-remove', ['docker', 'rm', '-f', cid]);
    command(role + '-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + cid]);
    if (read('stages/' + role + '-absent.raw.log').length) fail('owned extraction container remains');
    command(role + '-inspect', ['docker','image','inspect','--format','{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}',reference]);
    const image = json<Image>('stages/' + role + '-inspect.raw.log');
    if (!isDeepStrictEqual(image, final.images[role]) || image.os !== 'linux' || image.architecture !== arch || !/^sha256:[a-f0-9]{64}$/u.test(image.id)
      || !Array.isArray(image.repoDigests) || !image.repoDigests.includes(reference)) fail('actual image platform/digest mismatch');
  }
  const copied = (stageName: string, role: 'sdk' | 'runtime', sourcePath: string, destinationSuffix: string, maximum: number) => {
    const args = stages.get(stageName)?.command, cid = read('stages/' + role + '-create.raw.log').toString().trim();
    if (!args || args.length !== 7 || !args[0]!.startsWith('/') || !args[1]!.endsWith('/qlever/scripts/produce-linux-runtime-archive.py')
      || args[2] !== '--bounded-copy' || args[3] !== cid || args[4] !== sourcePath || !args[5]!.startsWith('/') || args[5]!.split('/').includes('..')
      || !args[5]!.endsWith(destinationSuffix) || !/^[1-9][0-9]*$/u.test(args[6]!) || Number(args[6]) > maximum) fail('canonical image original extraction missing: ' + stageName);
  };
  copied('runtime-copy', 'runtime', '/opt/xpod/qlever', '/original', 384 * 1024 ** 2);
  copied('sdk-profile-copy', 'sdk', '/opt/qlever-sdk/profile', '/sdk-profile', 32 * 1024 ** 2);
  for (const name of ['.xpod-build-contract.json', '.xpod-source-manifest', '.xpod-toolchain-identity', 'compile_commands.json', 'CMakeCache.txt']) {
    copied('sdk-copy-' + name.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, ''), 'sdk', '/opt/qlever-sdk/build/' + name, '/sdk-build/' + name, 256 * 1024 ** 2);
  }
  const prepareCid = read('ownership/prepare.cid').toString().trim();
  if (!/^[a-f0-9]{64}$/u.test(prepareCid)) fail('owned physical container identity missing');
  command('prepare-remove', ['docker', 'rm', '-f', prepareCid]);
  command('prepare-absent', ['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + prepareCid]);
  if (read('stages/prepare-absent.raw.log').length) fail('owned physical container remains');
  const profile = json<Record<string, unknown>>('sdk-profile/inputs.json');
  if (!isDeepStrictEqual(profile, final.compilerProfile) || profile.profile !== 'module-bookworm-gcc12' || profile.glibc !== '2.36'
    || profile.baseImage !== 'debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587'
    || profile.machine !== (input.target === 'linux-x64' ? 'x86_64' : 'aarch64') || profile.lockSha256 !== hash(input.qleverLock)) fail('actual SDK baseline/lock differs');
  for (const [original, reviewed] of [['sdk-profile/Dockerfile', 'docker/qlever-runtime-sdk/Dockerfile.module-bookworm'], ['sdk-profile/runtime.Dockerfile', 'docker/qlever-local-runtime/Dockerfile.module-bookworm']]) {
    if (!read(original!).equals(input.reviewedFiles.get(reviewed!)!)) fail('SDK Dockerfile original differs from immutable source');
  }
  const recipeHashes = profile.recipeHashes as Record<string, string>;
  for (const name of ['build-module-runtime-sdk.sh', 'build-qlever-runtime-sdk.sh', 'qlever_compiler_profile.py', 'validate-prior-sdk.py', 'run-focused-native-build.sh']) {
    if (recipeHashes?.[name] !== hash(input.reviewedFiles.get('qlever/scripts/' + name)!)) fail('SDK recipe source differs');
  }
  if (inventory.get('sdk-profile/dpkg-packages.txt')?.sha256 !== profile.packageLedgerSha256) fail('actual SDK package ledger differs');
  const contract = json<{ schemaVersion: number; component: string; toolchain: { profile: string; machine: string; profileInputs: unknown; gcc: string; gxx: string; compilerFiles: { c: string; cxx: string }; linkerSha256: string }; cmake: { buildType: string; positionIndependentCode: string; flags: Record<string, string> } }>('sdk-build/.xpod-build-contract.json');
  if (contract.schemaVersion !== 1 || contract.component !== 'qlever-runtime-sdk' || contract.toolchain?.profile !== 'module-bookworm-gcc12'
    || contract.toolchain.machine !== profile.machine || !isDeepStrictEqual(contract.toolchain.profileInputs, profile)
    || !/\b12\./u.test(contract.toolchain.gcc) || !/\b12\./u.test(contract.toolchain.gxx) || !SHA.test(contract.toolchain.compilerFiles?.c)
    || !SHA.test(contract.toolchain.compilerFiles?.cxx) || !SHA.test(contract.toolchain.linkerSha256) || contract.cmake?.buildType !== 'Release'
    || contract.cmake.positionIndependentCode !== 'ON' || contract.cmake.flags?.RANGES_NATIVE !== 'OFF') fail('actual SDK compiler contract differs');
  const cache = read('sdk-build/CMakeCache.txt').toString();
  if (!/^CMAKE_C_COMPILER:(?:FILEPATH|STRING)=\/[^\n]*\/gcc-12$/mu.test(cache) || !/^CMAKE_CXX_COMPILER:(?:FILEPATH|STRING)=\/[^\n]*\/g\+\+-12$/mu.test(cache)) fail('actual SDK CMake compiler cache differs');
  const originalManifest = json<Manifest>('original/manifest.json'), manifest = JSON.parse(input.manifest.toString()) as Manifest;
  if (originalManifest.build?.priorSdkImage !== final.sdkImage || hash(input.manifest) !== final.physicalManifestSha256 || inventory.get('physical/runtime/manifest.json')?.sha256 !== final.physicalManifestSha256
    || inventory.get('original/manifest.json')?.sha256 !== final.originalManifestSha256) fail('SDK/original/product manifest binding differs');
  const defines = [...input.physicalAbiHeader.toString().matchAll(/^\s*#define\s+XPOD_RDF_PHYSICAL_BACKEND_ABI_VERSION\s+(\d+)\b/gmu)];
  const lock = JSON.parse(input.qleverLock.toString()) as { repository: string; commit: string; patchSeriesSha256: string };
  const abi = Number(defines[0]?.[1]);
  if (defines.length !== 1 || !Number.isSafeInteger(abi) || abi <= 0 || manifest.schemaVersion !== 1 || manifest.adapterAbiVersion !== abi || manifest.physicalBackendAbiVersion !== abi
    || manifest.qlever?.repository !== lock.repository || manifest.qlever.commit !== lock.commit || manifest.qlever.patchSeriesSha256 !== lock.patchSeriesSha256
    || manifest.build?.source !== 'native-platform-build' || manifest.build.platform !== input.target || manifest.build.entrypoint !== 'qlever/scripts/prepare-linux-physical-runtime.py') fail('canonical source/ABI manifest differs');
  const physical = json<Physical>('physical/abi/physical-runtime.receipt.safe.json');
  if (physical.schemaVersion !== 1 || physical.target !== input.target || physical.ok !== true || physical.failure !== null || physical.releaseAccepted !== false
    || physical.originalManifestSHA256 !== final.originalManifestSha256 || inventory.get('physical/abi/physical-runtime.receipt.safe.json')?.sha256 !== final.abiReceiptSha256
    || !Array.isArray(physical.commands) || !physical.commands.length || physical.commands.length > 1024) fail('actual physical preparation originals missing');
  if (!Array.isArray(originalManifest.artifacts) || !originalManifest.artifacts.length || !Array.isArray(physical.originalBindings) || !Array.isArray(physical.files)) fail('original runtime/copy inventory missing');
  for (const row of originalManifest.artifacts) {
    const actual = inventory.get('original/' + row.path), binding = physical.originalBindings.find(item => item.path === row.path && item.original === '/original/' + row.path);
    if (!safe(row.path) || !actual || actual.sha256 !== row.sha256 || actual.sizeBytes !== row.size || !binding || binding.originalSHA256 !== row.sha256 || binding.originalBytes !== row.size) fail('original runtime/copy binding differs');
  }
  for (const row of physical.files) {
    const actual = inventory.get('physical/runtime/' + row.path);
    if (!safe(row.path) || !actual || actual.sha256 !== row.sha256 || actual.sizeBytes !== row.bytes) fail('physical output inventory differs');
  }
  if (new Set(physical.files.map(row => row.path)).size !== physical.files.length || physical.files.length !== input.members.size + 1 || !physical.files.some(row => row.path === 'manifest.json') || [...input.members.keys()].some(name => !physical.files.some(row => row.path === name))) fail('physical output inventory incomplete');
  for (const tool of ['ldd', 'patchelf', 'python3']) if (!physical.toolInputs?.[tool]?.path.startsWith('/') || !SHA.test(physical.toolInputs[tool]!.sha256)) fail('actual physical tool identity missing');
  for (const [i, row] of physical.commands.entries()) {
    if (!Array.isArray(row.command) || !row.command.length || !Object.values(physical.toolInputs).some(tool => tool.path === row.command[0]) || row.command.some(item => typeof item !== 'string') || row.actualExit !== 0 || row.actualWait !== true || row.rawClosed !== true || inventory.get(`physical/abi/${i}.stdout.raw`)?.sha256 !== row.stdoutSHA256
      || inventory.get(`physical/abi/${i}.stderr.raw`)?.sha256 !== row.stderrSHA256) fail('physical command exit/raw binding differs');
  }
  const verifier = physical.commands.findIndex(row => isDeepStrictEqual(row.command, [physical.toolInputs.python3?.path, '/workspace/qlever/scripts/verify-local-runtime-artifacts.py', '--prefix', '/out/runtime', '--lock', '/workspace/qlever/qlever.lock.json', '--build-source', input.target, '--smoke-database', '/out/abi/runtime-smoke.sqlite']));
  if (verifier < 0) fail('executed canonical protocol verifier command missing');
  const smoke = json<{ manifestSha256: string; adapterAbiVersion: number }>(`physical/abi/${verifier}.stdout.raw`);
  if (smoke.manifestSha256 !== final.physicalManifestSha256 || smoke.adapterAbiVersion !== abi) fail('executed protocol output differs');
  const loader = new Map<string, ReturnType<typeof observeLinuxElfRanges>>();
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 1024 || manifest.artifacts.length !== input.members.size) fail('complete ELF inventory required');
  for (const row of manifest.artifacts) {
    const member = input.members.get(row.path), original = inventory.get('physical/runtime/' + row.path);
    if (!safe(row.path) || loader.has(row.path) || !member || !original || member.reference.path !== row.path || member.reference.sha256 !== row.sha256 || member.reference.sizeBytes !== row.size
      || original.sha256 !== row.sha256 || original.sizeBytes !== row.size) fail('actual native product differs from physical runtime');
    loader.set(row.path, observeLinuxElfRanges(member, input.target));
  }
  const executable = loader.get('bin/xpod_qlever_local_runtime');
  if (!executable?.interpreter || input.members.get('bin/xpod_qlever_local_runtime')?.reference.sha256 !== final.runtimeBinarySha256) fail('actual native executable binding differs');
  const system = json<{ target: string; glibc: string; systemLibraries: { name: string; sha256: string }[] }>('physical/abi/system-abi.safe.json');
  if (system.target !== input.target || !/\b2\.36\b/u.test(system.glibc) || !Array.isArray(system.systemLibraries)) fail('actual system ABI baseline differs');
  const versionCommand = physical.commands.findIndex(row => isDeepStrictEqual(row.command, [physical.toolInputs.ldd!.path, '--version']));
  if (versionCommand < 0 || read(`physical/abi/${versionCommand}.stdout.raw`).toString().split('\n')[0] !== system.glibc) fail('actual glibc command original differs');
  for (const [name, elf] of loader) {
    if (elf.soname && (!name.startsWith('lib/') || elf.soname !== name.slice(name.lastIndexOf('/') + 1))) fail('ELF soname/physical placement differs');
    if (elf.rpath !== (name.startsWith('bin/') ? '$ORIGIN/../lib' : '$ORIGIN')) fail('physical ELF loader path differs');
    const rpath = name.startsWith('bin/') ? '$ORIGIN/../lib' : '$ORIGIN';
    const patches = physical.commands.filter(row => isDeepStrictEqual(row.command, [physical.toolInputs.patchelf!.path, '--set-rpath', rpath, '/out/runtime/' + name]));
    const observations = physical.commands.map((row, index) => ({ row, index })).filter(({ row }) => isDeepStrictEqual(row.command, [physical.toolInputs.ldd!.path, '/out/runtime/' + name]));
    if (patches.length !== 1 || observations.length !== 1) fail('actual final ELF patch/loader observation missing');
    const resolved = new Map<string, string>();
    for (const line of read(`physical/abi/${observations[0]!.index}.stdout.raw`).toString().split('\n').map(row => row.trim()).filter(Boolean)) {
      if (/^linux-vdso\.so\.1 \(0x[a-f0-9]+\)$/u.test(line)) continue;
      const linked = /^([A-Za-z0-9_.+-]+) => (\/[^\s]+) \(0x[a-f0-9]+\)$/u.exec(line), direct = /^(\/[^\s]+) \(0x[a-f0-9]+\)$/u.exec(line);
      if (!linked && !direct) fail('unresolved or unknown ldd original');
      const path = linked ? linked[2]! : direct![1]!, library = linked ? linked[1]! : path.slice(path.lastIndexOf('/') + 1);
      if (path.split('/').includes('..') || resolved.has(library) && resolved.get(library) !== path) fail('unsafe or ambiguous actual loader path');
      if (!SYSTEM.has(library) && path !== '/out/runtime/lib/' + library) fail('actual loader resolves outside physical bundle');
      if (!SYSTEM.has(library) && !loader.has('lib/' + library)) fail('actual loader member absent');
      resolved.set(library, path);
    }
    if (!resolved.size || elf.needed.some(dependency => !resolved.has(dependency))) fail('actual loader/declaration inventory differs');
    for (const dependency of elf.needed) {
      if (SYSTEM.has(dependency)) { if (!system.systemLibraries.some(row => row.name === dependency && SHA.test(row.sha256))) fail('system ABI dependency original missing'); }
      else if (!loader.has('lib/' + dependency)) fail('unbundled non-system ELF dependency');
    }
  }
  const pending = ['qlever-linux-sdk-original-build-process-and-complete-input-source-closure-unavailable'];
  for (const name of ['.xpod-build-contract.json', '.xpod-source-manifest', '.xpod-toolchain-identity', 'compile_commands.json', 'CMakeCache.txt']) if (!inventory.get('sdk-build/' + name)?.sizeBytes) pending.push('qlever-linux-sdk-original-missing:' + name);
  return Object.freeze({ status: 'mechanical-linux-qlever-runtime-originals-verified' as const, target: input.target, binarySha256: final.runtimeBinarySha256,
    physicalBackendAbiVersion: abi, adapterAbiVersion: abi, loaderClosureVerified: true as const, executedCanonicalProtocolVerified: true as const,
    sourceSdkCompletenessVerified: false as const, pending: Object.freeze(pending), scope: 'actual Linux ELF/physical protocol/extraction stage originals; complete SDK/source/origin admission remains separate' as const });
}
