import { captureLegalFileIdentity, assertLegalFileIdentity, type LegalFileIdentity } from './legal-file-custody';
import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { mkdir, open, stat, chmod, statfs } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as yauzl from 'yauzl';
const TARGETS = {
  'linux-x64': { name: 'bun-linux-x64.zip', sha256: '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913', root: 'bun-linux-x64' },
  'linux-arm64': { name: 'bun-linux-aarch64.zip', sha256: '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7', root: 'bun-linux-aarch64' },
  'darwin-x64': { name: 'bun-darwin-x64.zip', sha256: '80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012', root: 'bun-darwin-x64' },
  'darwin-arm64': { name: 'bun-darwin-aarch64.zip', sha256: '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f', root: 'bun-darwin-aarch64' },
} as const;
export type OfficialBun142Target = keyof typeof TARGETS;
export interface OfficialBun142RuntimeView {
  readonly target: OfficialBun142Target; readonly version: '1.4.2';
  readonly commit: '744846f844374847c902b5e7fd59b4342a51ef99'; readonly revision: '1.4.2+744846f84';
  readonly executableSha256: string; readonly executableBytes: number;
  readonly archivePath: string; readonly archiveSha256: string; readonly archiveBytes: number;
  readonly checksumsSha256: string;
  readChecksums(): Buffer;
  readArchiveRange(offset: number, length: number): Buffer;
}
/** The existing caller-owned budget must be the sole reservation/deadline authority. */
export interface CandidateServiceBun142Parent {
  check(): void;
  remainingMs(): number;
  reserveOriginalMaximum(maximum: number): object;
  settleOriginalReservation(token: object, actual: number, unusedOriginalsAbsent: boolean): void;
}
interface IssuedBun142Runtime {
  view: OfficialBun142RuntimeView; identities: readonly LegalFileIdentity[]; check?: () => void; parent?: CandidateServiceBun142Parent;
}
const issued = new WeakMap<object, IssuedBun142Runtime>();
const observations = new Map<OfficialBun142Target, Promise<object>>();
const servicePending = new WeakMap<object, Map<OfficialBun142Target, Promise<object>>>();
const SERVICE_TARGET_MAXIMUM = 64 * 1024 ** 2;
function issuedRuntime(capability: unknown): IssuedBun142Runtime {
  const record = capability && typeof capability === 'object' ? issued.get(capability) : undefined;
  if (!record) fail('issued official runtime capability required');
  record.check?.();
  return record;
}
export function assertOfficialBun142RuntimeCustody(capability: unknown): void {
  const record = issuedRuntime(capability);
  for (const identity of record.identities) assertLegalFileIdentity(identity);
}
export function officialBun142RuntimeView(capability: unknown): OfficialBun142RuntimeView | undefined {
  const record = capability && typeof capability === 'object' ? issued.get(capability) : undefined;
  if (!record) return undefined;
  assertOfficialBun142RuntimeCustody(capability); return record.view;
}
/** Only a service observation issued against this exact shared parent qualifies. */
export function candidateServiceBun142RuntimeView(capability:unknown,parent:CandidateServiceBun142Parent):OfficialBun142RuntimeView|undefined {
  const record=capability&&typeof capability==='object'?issued.get(capability):undefined;
  if(!record||record.parent!==parent)return undefined;
  return officialBun142RuntimeView(capability);
}
function serviceRemainingMs(parent: CandidateServiceBun142Parent): number {
  const remaining = parent.remainingMs();
  if (!Number.isFinite(remaining) || remaining <= 0) fail('service parent deadline exhausted');
  return remaining;
}
function checkServiceParent(parent: CandidateServiceBun142Parent): number {
  parent.check(); return serviceRemainingMs(parent);
}
function validServiceParent(parent: unknown): parent is CandidateServiceBun142Parent {
  return Boolean(parent) && (typeof parent === 'object' || typeof parent === 'function')
    && ['check', 'remainingMs', 'reserveOriginalMaximum', 'settleOriginalReservation']
      .every(key => typeof (parent as Record<string, unknown>)[key] === 'function');
}
const SUMS_SHA = '99ebf3e6afe003b57eae3f257abce7e9aa851452429e84ef16b1b401e9d7cff1';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(reason: string): never { throw Error('Official Bun runtime: ' + reason); }
async function fileHash(filename: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) { if (signal?.aborted) fail('file hash deadline'); digest.update(chunk); }
  return digest.digest('hex');
}
async function official(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  const host = new URL(response.url).hostname;
  if (!response.ok || !response.body || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(host)) fail('official asset response rejected');
  return response;
}
async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) fail('asset body absent');
  const reader = response.body.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
  finally { await reader.cancel().catch(() => {}); }
}
/** The only target-runtime issuer. Four fixed official assets bound total
 * retained successful/partial ZIP storage to 256MiB; one target is fetched per
 * request under 30s. Foreign executables are hashed, never executed. */
export function observeOfficialBun142Runtime(target: OfficialBun142Target): Promise<object> {
  if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) return Promise.reject(Error('Official Bun runtime: unsupported fixed target'));
  const prior = observations.get(target);
  if (prior) return prior.then(capability => { assertOfficialBun142RuntimeCustody(capability); return capability; });
  const observed = observeTarget(target);
  observations.set(target, observed);
  void observed.catch(() => { if (observations.get(target) === observed) observations.delete(target); });
  return observed;
}
/** A fixed-release cached ZIP can use its actual authenticated size. This is
 * only reservation sizing; observeTarget still performs the sole issuance. */
function cachedServiceReservation(targetName:OfficialBun142Target,parent:CandidateServiceBun142Parent):{maximum:number;identity?:LegalFileIdentity} {
 const target=TARGETS[targetName],root=fileURLToPath(new URL('../../../.test-data/legal-bun-runtime/',import.meta.url));
 const filename=path.join(root,target.name+'.'+target.sha256+'.original.zip');
 checkServiceParent(parent);let fd:number;
 try{fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {maximum:SERVICE_TARGET_MAXIMUM};throw error;}
 try{
  const before=fstatSync(fd,{bigint:true});
  if(!before.isFile()||before.size<=0n||before.size>BigInt(SERVICE_TARGET_MAXIMUM-8192))fail('cached reservation ZIP bound');
  const identity=captureLegalFileIdentity(filename),digest=createHash('sha256'),block=Buffer.alloc(65536);
  for(const key of ['dev','ino','size','ctimeNs','mtimeNs','mode','nlink'] as const)if(before[key]!==identity[key])fail('cached reservation named/held identity differs');
  for(let offset=0;offset<Number(before.size);){checkServiceParent(parent);const n=readSync(fd,block,0,Math.min(block.length,Number(before.size)-offset),offset);if(!n)fail('cached reservation ZIP shortened');digest.update(block.subarray(0,n));offset+=n;}
  const after=fstatSync(fd,{bigint:true});for(const key of ['dev','ino','size','ctimeNs','mtimeNs','mode','nlink'] as const)if(before[key]!==after[key])fail('cached reservation ZIP changed');
  assertLegalFileIdentity(identity);checkServiceParent(parent);
  if(digest.digest('hex')!==target.sha256)fail('cached reservation ZIP differs from fixed release');
  return {maximum:Number(before.size)+8192,identity};
 }finally{closeSync(fd);}
}
/** Service-parent observation reuses this issuer and the fixed official target
 * only. Cold downloads reserve 64MiB; authenticated held ZIPs reserve their
 * exact ZIP size plus the existing checksum maximum. The returned
 * capability remains bound to the parent's lifetime and original custody. */
export function observeCandidateServiceBun142Runtime(target: OfficialBun142Target, parent: CandidateServiceBun142Parent): Promise<object> {
  if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) return Promise.reject(Error('Official Bun runtime: unsupported fixed target'));
  if (!validServiceParent(parent)) return Promise.reject(Error('Official Bun runtime: complete existing service parent required'));
  const owner = parent as object;
  let pending = servicePending.get(owner);
  if (!pending) { pending = new Map(); servicePending.set(owner, pending); }
  const prior = pending.get(target);
  if (prior) return prior.then(capability => { assertOfficialBun142RuntimeCustody(capability); return capability; });
  try { checkServiceParent(parent); } catch (error) { return Promise.reject(error); }
  let token: object;let reservation:{maximum:number;identity?:LegalFileIdentity};
  try {
    reservation=cachedServiceReservation(target,parent);
    token = parent.reserveOriginalMaximum(reservation.maximum);
    if (!token || typeof token !== 'object') fail('actual service parent reservation token required');
    checkServiceParent(parent);
  } catch (error) { return Promise.reject(error); }
  const observed = observeTarget(target, { parent, token, maximum: reservation.maximum, cachedIdentity:reservation.identity });
  pending.set(target, observed);
  void observed.catch(() => { if (pending!.get(target) === observed) pending!.delete(target); });
  return observed;
}
async function observeTarget(targetName: OfficialBun142Target, service?: { parent: CandidateServiceBun142Parent; token: object; maximum: number; cachedIdentity?:LegalFileIdentity }): Promise<object> {
  const target = TARGETS[targetName];
  const parent = service?.parent;
  if(service?.cachedIdentity)assertLegalFileIdentity(service.cachedIdentity);
  const check = () => { if(parent) checkServiceParent(parent); };
  const signal = AbortSignal.timeout(parent ? Math.max(1, Math.min(30000, Math.floor(parent.remainingMs()))) : 30000);
  const checkParent = () => {
    if (!parent) return;
    parent.check();
    if (!Number.isFinite(parent.remainingMs()) || parent.remainingMs() <= 0) fail('service parent deadline exhausted');
  };
  const fileHashChecked = async (filename: string) => { checkParent(); const value = await fileHash(filename, signal); checkParent(); return value; };
  const root = fileURLToPath(new URL('../../../.test-data/legal-bun-runtime/', import.meta.url));
  await mkdir(root, { recursive: true });
  checkParent();
  const sumsPath = path.join(root, 'SHASUMS256.' + SUMS_SHA + '.original.txt');
  let sums:Buffer|undefined;
  if(service){
    let fd:number|undefined;
    try{checkParent();fd=openSync(sumsPath,constants.O_RDONLY|constants.O_NOFOLLOW);const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>8192n)fail('cached checksums bound');const bytes=Buffer.alloc(Number(before.size));let at=0;while(at<bytes.length){checkParent();const count=readSync(fd,bytes,at,bytes.length-at,at);if(!count)fail('cached checksums shortened');at+=count;}const after=fstatSync(fd,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const)if(before[key]!==after[key])fail('cached checksums changed');sums=bytes;checkParent();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}finally{if(fd!==undefined)closeSync(fd);}
  }
  if(!sums){
    const sumsResponse = await official('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt', signal);
    checkParent();const sumsChunks:Buffer[]=[];let sumsBytes=0;
    for await(const bytes of responseChunks(sumsResponse)){checkParent();sumsBytes+=bytes.length;if(sumsBytes>8192)fail('checksum budget');sumsChunks.push(Buffer.from(bytes));}
    sums=Buffer.concat(sumsChunks);
  }
  checkParent();
  if(hash(sums)!==SUMS_SHA||!sums.toString().split('\n').includes(target.sha256+'  '+target.name))fail('fixed release checksum differs');
  await open(sumsPath, 'wx').then(async file => { try { await file.writeFile(sums); } finally { await file.close(); } }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fileHashChecked(sumsPath) !== SUMS_SHA) throw error; });
  checkParent();
  if (((await stat(sumsPath)).mode & 0o777) !== 0o444) await chmod(sumsPath, 0o444);
  checkParent();
  const sumsIdentity = captureLegalFileIdentity(sumsPath);
  checkParent();
  const archivePath = path.join(root, target.name + '.' + target.sha256 + '.original.zip');
  const exists = await stat(archivePath).catch(() => undefined);
  checkParent();
  if (!exists) {
    const free = await statfs(root, { bigint: true });
    checkParent();
    if (free.bavail * free.bsize < BigInt(1024 ** 3 + 64 * 1024 ** 2)) fail('download free-space floor');
    const temporary = archivePath + '.download.original';
    const file = await open(temporary, 'wx'); let size = 0;
    try {
      const response = await official('https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/' + target.name, signal);
      checkParent();
      for await (const bytes of responseChunks(response)) {
        checkParent();
        size += bytes.length; if (size > (service?.maximum??SERVICE_TARGET_MAXIMUM) - 8192) fail('single-target aggregate download budget');
        for (let offset = 0; offset < bytes.length; offset += 65536) { checkParent(); await file.writeFile(Buffer.from(bytes.subarray(offset, offset + 65536))); }
      }
    } finally { await file.close(); }
    checkParent();
    if (await fileHashChecked(temporary) !== target.sha256) fail('downloaded ZIP differs');
    // Preserve the verified audit original; no overwrite or deletion of originals.
    await chmod(temporary, 0o444);
    const { link } = await import('node:fs/promises'); await link(temporary, archivePath);
    checkParent();
  }
  const archiveIdentity = captureLegalFileIdentity(archivePath);
  checkParent();
  if ((await stat(archivePath)).size > (service?.maximum??SERVICE_TARGET_MAXIMUM) - 8192 || await fileHashChecked(archivePath) !== target.sha256) fail('cached ZIP differs');
  checkParent();
  if (signal.aborted) fail('asset verification deadline');
  const executable = await inspectBunRuntimeZip(archivePath, target.root, signal, checkParent);
  checkParent();
  assertLegalFileIdentity(archiveIdentity); assertLegalFileIdentity(sumsIdentity);
  checkParent();
  const capability = Object.freeze({}), archiveBytes = Number(archiveIdentity.size);
  let rangeBytes = 0, rangeCalls = 0;
  const view: OfficialBun142RuntimeView = Object.freeze({ target: targetName, version: '1.4.2',
    commit: '744846f844374847c902b5e7fd59b4342a51ef99', revision: '1.4.2+744846f84',
    executableSha256: executable.sha256, executableBytes: executable.bytes,
    archivePath, archiveSha256: target.sha256, archiveBytes, checksumsSha256: SUMS_SHA,
    readChecksums() { assertOfficialBun142RuntimeCustody(capability); return Buffer.from(sums); },
    readArchiveRange(offset: number, length: number) {
      assertOfficialBun142RuntimeCustody(capability);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536
        || offset + length > archiveBytes || rangeCalls >= 4096 || rangeBytes + length > 64 * 1024 ** 2) fail('bounded runtime original range required');
      rangeCalls++; rangeBytes += length;
      assertOfficialBun142RuntimeCustody(capability);
      const fd = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW), bytes = Buffer.alloc(length);
      try {
        const actual = fstatSync(fd, { bigint: true });
        for (const key of ['dev','ino','size','ctimeNs','mtimeNs','mode','nlink'] as const) if (actual[key] !== archiveIdentity[key]) fail('runtime original fd changed');
        for (let read = 0; read < length;) { check(); const count = readSync(fd, bytes, read, length - read, offset + read); if (!count) fail('runtime original truncated'); read += count; }
        assertOfficialBun142RuntimeCustody(capability); return bytes;
      } finally { closeSync(fd); }
    },
  });
  if (service) {
    checkParent();
    // A successful historical download keeps a hard-link audit alias. It is
    // the same allocated original, not an unaccounted second partial body.
    const alias=await stat(archivePath+'.download.original',{bigint:true}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return undefined;});
    if(alias&&(alias.dev!==archiveIdentity.dev||alias.ino!==archiveIdentity.ino||alias.size!==archiveIdentity.size))fail('unaccounted service download partial');
    checkParent();
    if(service.cachedIdentity)assertLegalFileIdentity(service.cachedIdentity);
    parent!.settleOriginalReservation(service.token, archiveBytes + sums.length, true);
  }
  issued.set(capability, { view, identities: Object.freeze([archiveIdentity, sumsIdentity]), ...(parent ? { parent, check: () => { checkServiceParent(parent); } } : {}) });
  return capability;
}
/** Current-controller helper compatibility uses the same official issuer, then
 * independently binds the already running executable. No foreign execution. */
export async function observeLinuxBun142Executable(): Promise<{ sha256: string; archivePath: string; archiveSha256: string; archiveIdentity: LegalFileIdentity }> {
  const target = `${process.platform}-${process.arch}`;
  if (target !== 'linux-x64' && target !== 'linux-arm64') fail('unsupported controller target');
  const capability = await observeOfficialBun142Runtime(target), view = officialBun142RuntimeView(capability)!;
  const executableIdentity = captureLegalFileIdentity(process.execPath);
  if (await fileHash(process.execPath, AbortSignal.timeout(30000)) !== view.executableSha256) fail('official ZIP executable differs from controller');
  assertLegalFileIdentity(executableIdentity); assertOfficialBun142RuntimeCustody(capability);
  return Object.freeze({ sha256: view.executableSha256, archivePath: view.archivePath,
    archiveSha256: view.archiveSha256, archiveIdentity: captureLegalFileIdentity(view.archivePath) });
}

/** Bounded ZIP parser only, never official custody or an executable issuer. */
export async function inspectBunExecutableZip(archivePath: string, expectedRoot: string, signal: AbortSignal): Promise<string> {
  return (await inspectBunRuntimeZip(archivePath, expectedRoot, signal)).sha256;
}
function inspectBunRuntimeZip(archivePath: string, expectedRoot: string, signal: AbortSignal, check?: () => void): Promise<{ sha256: string; bytes: number }> {
  if (!/^bun-(?:linux|darwin)-(?:x64|aarch64)$/u.test(expectedRoot) || signal.aborted) return Promise.reject(Error('ZIP target/deadline'));
  return new Promise<{ sha256: string; bytes: number }>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(error ?? Error('ZIP missing')); return; }
      const entries: yauzl.Entry[] = []; const names = new Set<string>(); let expanded = 0;
      const abort = () => { zip.close(); reject(check ? Error('Official Bun runtime: service parent deadline exhausted') : Error('Official Bun runtime: ZIP deadline')); };
      signal.addEventListener('abort', abort, { once: true });
      const failed = (reason: unknown) => { signal.removeEventListener('abort', abort); zip.close(); reject(reason); };
      const parsed = (reason: unknown) => { if (!check) return false; try { check(); return false; } catch (error) { failed(error); return true; } };
      zip.on('error', failed);
      zip.on('entry', entry => {
        if (parsed(undefined)) return;
        const mode = entry.externalFileAttributes >>> 16;
        if (names.has(entry.fileName) || entries.length >= 8 || ![expectedRoot + '/', expectedRoot + '/bun'].includes(entry.fileName)
          || ((mode & 0o170000) !== 0 && (mode & 0o170000) !== (entry.fileName.endsWith('/') ? 0o040000 : 0o100000)) || (entry.generalPurposeBitFlag & 1)) { failed(Error('Unsafe official ZIP inventory')); return; }
        names.add(entry.fileName); expanded += entry.uncompressedSize;
        if (expanded > 256 * 1024 ** 2) { failed(Error('ZIP expansion budget')); return; }
        entries.push(entry); zip.readEntry();
      });
      zip.on('end', () => {
        if (parsed(undefined)) return;
        const entry = entries.find(row => row.fileName === expectedRoot + '/bun');
        if (!entry || !entry.uncompressedSize) { failed(Error('Exact official executable absent')); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { failed(streamError ?? Error('ZIP executable stream missing')); return; }
          const digest = createHash('sha256'); let size = 0;
          stream.on('error', failed);
          stream.on('data', (bytes: Buffer) => {
            if (parsed(undefined)) { stream.destroy(Error('Official Bun runtime: service parent deadline exhausted')); return; }
            size += bytes.length; if (size > entry.uncompressedSize) { stream.destroy(Error('ZIP executable size')); return; } digest.update(bytes);
          });
          stream.on('end', () => { if (size !== entry.uncompressedSize) { failed(Error('ZIP executable truncated')); return; } signal.removeEventListener('abort', abort); zip.close(); resolve({ sha256: digest.digest('hex'), bytes: size }); });
        });
      });
      zip.readEntry();
    });
  });
}
