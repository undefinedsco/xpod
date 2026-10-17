import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import limits from '../module-artifact-limits.json';
import { openBoundOriginalFile, type BoundOriginalReference } from './bound-original-file';
import { PUBLICATION_DISK_LIMITS } from './publication-disk-budget';
/** Internal custody implementation; it issues no admission capability. The caller
 * supplies the complete previously verified ZIP inventory and owned cache root. */
export function lazyZipOriginals(input: {
  archivePath: string; archiveSha256: string; root: string;
  members: readonly BoundOriginalReference[];
}) {
  const fail = (reason: string): never => { throw Error('Lazy ZIP originals: ' + reason); };
  for (let current = path.resolve(input.archivePath); ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked archive ancestor');
    if (current === path.dirname(current)) break;
  }
  const before = fs.lstatSync(input.archivePath);
  if (!before.isFile() || before.nlink !== 1 || before.size > PUBLICATION_DISK_LIMITS.outerPackedBytes
    || !/^[a-f0-9]{64}$/u.test(input.archiveSha256)) fail('bounded ordinary archive required');
  const same = (row: fs.Stats) => row.dev === before.dev && row.ino === before.ino && row.size === before.size
    && row.mtimeMs === before.mtimeMs && row.ctimeMs === before.ctimeMs && row.nlink === 1 && row.mode === before.mode;
  const fd = fs.openSync(input.archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let closed = false, hydrated = 0, projectionMilliseconds = 0;
  const started = Date.now();
  const cache = new Map<string, {file: string; bytes: number; small: boolean; reader: ReturnType<typeof openBoundOriginalFile>}>();
  const rows = new Map(input.members.map(row => [row.path, row]));
  const assertUnchanged = () => {
    if (closed || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(input.archivePath))) fail('registered archive identity revoked or changed');
  };
  const close = () => {
    if (closed) return;
    for (const value of cache.values()) { value.reader.close(); fs.rmSync(value.file, {force:true}); }
    cache.clear(); fs.closeSync(fd); closed = true;
  };
  try {
    assertUnchanged();
    const scratch = Buffer.alloc(limits.rangeBytes), digest = createHash('sha256');
    for (let offset = 0; offset < before.size;) {
      if (Date.now() - started >= limits.timeoutMs) fail('archive full-hash deadline');
      const count = fs.readSync(fd, scratch, 0, Math.min(scratch.length, before.size-offset), offset);
      if (!count) fail('archive truncated'); digest.update(scratch.subarray(0,count)); offset += count;
    }
    if (digest.digest('hex') !== input.archiveSha256) fail('archive full SHA mismatch');
    assertUnchanged();
    if (rows.size !== input.members.length || input.members.some(row => !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || row.bytes > limits.shardBytes || Buffer.byteLength(row.path) > 255 || !/^[a-f0-9]{64}$/u.test(row.sha256))) fail('registered bounded unique members required');
    const root = fs.lstatSync(input.root);
    if (!root.isDirectory() || root.isSymbolicLink() || fs.realpathSync(input.root) !== input.root) fail('owned canonical cache root required');
  } catch(error) { close(); throw error; }
  const reader = (name: string) => {
    assertUnchanged();
    const row = rows.get(name); if (!row) return fail('registered original required');
    const found = cache.get(name);
    if (found) { cache.delete(name); cache.set(name, found); return found.reader; }
    const small = row.bytes <= limits.metadataBytes;
    const capacity = small ? PUBLICATION_DISK_LIMITS.metadataCacheBytes : limits.shardBytes;
    for (const key of zipCacheEvictions([...cache].map(([key,value])=>({key,bytes:value.bytes,small:value.small})),{bytes:row.bytes,small,capacity})) {
      const value=cache.get(key)!;value.reader.close();fs.rmSync(value.file,{force:true});cache.delete(key);
    }
    if ((hydrated += row.bytes) > input.members.reduce((sum,value)=>sum+value.bytes,0)*4 + 1024**2) fail('aggregate rehydration budget exceeded');
    const remaining = limits.timeoutMs - projectionMilliseconds;
    if (remaining <= 0) fail('projection aggregate deadline');
    const free = fs.statfsSync(input.root,{bigint:true});
    if (free.bavail*free.bsize < BigInt(row.bytes + limits.freeFloorBytes + limits.queueReserveBytes)) fail('cache free-space floor insufficient');
    const file = path.join(input.root, createHash('sha256').update(name).digest('hex'));
    const projectionStarted=Date.now();
    const result = spawnSync(process.platform==='win32'?'python':'python3', [path.resolve(import.meta.dir,'../extract-bound-zip-member.py')], {
      input:JSON.stringify({archiveBytes:before.size,member:row,destination:file,timeoutMs:remaining,freeFloorBytes:limits.freeFloorBytes}),
      timeout:remaining,maxBuffer:65536,stdio:['pipe','pipe','pipe',fd],
    });
    projectionMilliseconds+=Date.now()-projectionStarted;
    try {
      assertUnchanged();
      if (result.error || result.status !== 0 || result.signal) fail('bounded member projection failed: '+String(result.stderr).slice(0,512));
      const actual = JSON.parse(String(result.stdout));
      if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) fail('member projection identity mismatch');
      const bound = openBoundOriginalFile(file,row);
      cache.set(name,{file,bytes:row.bytes,small,reader:bound}); return bound;
    } catch(error) { fs.rmSync(file,{force:true}); throw error; }
  };
  return Object.freeze({
    readRange(name:string,offset:number,length:number) { return reader(name).readRange(offset,length); },
    assertRetainedOriginal(){if(!same(fs.lstatSync(input.archivePath))||(!closed&&!same(fs.fstatSync(fd))))fail('retained archive identity changed');},
    close,
    cacheBytes() { return [...cache.values()].reduce((sum,value)=>sum+value.bytes,0); },
  });
}

/** LRU byte accounting shared by the actual projection cache and budget tests. */
export function zipCacheEvictions(rows:readonly {key:string;bytes:number;small:boolean}[],incoming:{bytes:number;small:boolean;capacity:number}):readonly string[]{
 let used=rows.filter(value=>value.small===incoming.small).reduce((sum,value)=>sum+value.bytes,0),count=rows.length;
 const evicted:string[]=[];
 for(const value of rows){
  if(used+incoming.bytes<=incoming.capacity&&count<32)break;
  if(value.small===incoming.small||count>=32){evicted.push(value.key);count--;if(value.small===incoming.small)used-=value.bytes;}
 }
 if(used+incoming.bytes>incoming.capacity)throw Error('Incoming ZIP original exceeds cache byte capacity');
 return evicted;
}
