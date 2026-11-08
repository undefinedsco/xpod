import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {inspectSourceOriginalTar,inspectGzipBlockSourceOriginalTar,createGzipBlockSourceReader} from '../../scripts/lib/independent-admission/source-original-tar';
import {openBoundOriginalFile} from '../../scripts/lib/independent-admission/bound-original-file';
import limits from '../../scripts/lib/module-artifact-limits.json';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(run:(f:any)=>void){const base=path.resolve(import.meta.dir,'../../.test-data');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'gzip-originals-'));
 try{const code=`import importlib.util,pathlib,json,sys,os\np=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('capture',p/'scripts/lib/module-source-materials.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nr=pathlib.Path(sys.argv[2]);source=r/'source';source.mkdir();(source/'a').write_bytes(b'a'*200000);(source/'random').write_bytes(os.urandom(196608));(source/'link').symlink_to('a');charged=[0]\ndef reserve(n):charged[0]+=n\nfiles=[('node_modules/a',source/'a'),('node_modules/random',source/'random'),('node_modules/link',source/'link')]\nresult={}\nfor encoding in ['raw','gzip-blocks-v1']:\n out=r/encoding;out.mkdir();result[encoding]=m.capture_group(out,out,'dependencies',files,source,reserve_bytes=reserve,archive_encoding=encoding)\nresult['charged']=charged[0];result['actual']=sum(p.stat().st_size for p in r.rglob('*') if p.is_file() and source not in p.parents)\n(r/'result.json').write_text(json.dumps(result))\n`;
  const result=spawnSync('/usr/bin/python3',['-I','-S','-B','-c',code,path.resolve(import.meta.dir,'../..'),root],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr);const all=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));
  const group=all['gzip-blocks-v1'],archive=group.archives[0],index=JSON.parse(fs.readFileSync(path.join(root,'gzip-blocks-v1',archive.index.path),'utf8')),packed=fs.readFileSync(path.join(root,'gzip-blocks-v1',archive.path)),rows=new Map(group.inventories.flatMap((r:any)=>JSON.parse(fs.readFileSync(path.join(root,'gzip-blocks-v1',r.path),'utf8'))).map((r:any)=>[r.path,r]));
  run({root,all,group,archive,index,packed,rows,inspect:(changes:any={})=>{let reads=0,bytes=0;const observed=inspectGzipBlockSourceOriginalTar({archive,index,rows,check(){},readRange(name,offset,length){expect(name).toBe(archive.path);expect(length<=limits.rangeBytes).toBe(true);reads++;bytes+=length;return packed.subarray(offset,offset+length);},...changes});return{observed,reads,bytes};}});
 }finally{fs.rmSync(root,{recursive:true,force:true});}}
test('actual Python opt-in emits standard bounded gzip and charges actual compressed bytes plus both metadata originals',()=>fixture((f:any)=>{
 expect(f.all.charged).toBe(f.all.actual);expect(f.index.blocks.some((row:any)=>row.bytes>limits.rangeBytes)).toBe(true);expect(f.archive.encoding).toBe('gzip-blocks-v1');expect(f.archive.bytes<f.all.raw.archives[0].bytes).toBe(true);const result=f.inspect();expect(result.observed.seen.size).toBe(3);expect(result.observed.locations).toBeUndefined();expect(result.bytes).toBe(f.archive.bytes);expect(f.all.raw.archives[0].encoding).toBeUndefined();
 const raw=f.all.raw,ref=raw.archives[0],rows=new Map(raw.inventories.flatMap((r:any)=>JSON.parse(fs.readFileSync(path.join(f.root,'raw',r.path),'utf8'))).map((r:any)=>[r.path,r]));const body=fs.readFileSync(path.join(f.root,'raw',ref.path));expect(inspectSourceOriginalTar({archive:ref,rows:rows as any,check(){},readRange:(_n,o,l)=>body.subarray(o,o+l)}).locations.size).toBe(2);
}));
test('missing or forged index spans, extra fields, unknown sizes, complete packed SHA and expanded SHA all fail closed',()=>fixture((f:any)=>{
 for(const change of [(x:any)=>delete x.blocks,(x:any)=>x.blocks[0].offset=1,(x:any)=>x.blocks[1].expandedOffset--,(x:any)=>x.blocks[0].bytes=true,(x:any)=>x.extra=true,(x:any)=>x.expanded.bytes=limits.shardBytes+1,(x:any)=>x.expanded.sha256='0'.repeat(64)]){const index=structuredClone(f.index);change(index);expect(()=>f.inspect({index})).toThrow();}
 expect(()=>f.inspect({archive:{...f.archive,sha256:'0'.repeat(64)},index:{...f.index,archive:{path:f.archive.path,bytes:f.archive.bytes,sha256:'0'.repeat(64)}}})).toThrow('complete encoded original digest');
}));
test('one block cannot hide concatenated members, trailing bytes, CRC damage or a bounded decompression bomb',()=>fixture((f:any)=>{
 const first=f.index.blocks[0],member=f.packed.subarray(first.offset,first.offset+first.bytes);const cases=[Buffer.concat([member,gzipSync(Buffer.from('hidden'))]),Buffer.concat([member,Buffer.from('tail')]),gzipSync(Buffer.alloc(limits.rangeBytes+1))];const bad=Buffer.from(member);bad[bad.length-8]^=1;cases.push(bad);
 for(const packed of cases){const archive={path:f.archive.path,bytes:packed.length,sha256:sha(packed)},index={schemaVersion:1,kind:'source-tar-gzip-block-index',archive,expanded:{bytes:limits.rangeBytes,sha256:'0'.repeat(64)},blocks:[{offset:0,bytes:packed.length,expandedOffset:0,expandedBytes:limits.rangeBytes}]};expect(()=>f.inspect({archive,index,readRange:(_n:string,o:number,l:number)=>packed.subarray(o,o+l)})).toThrow();}
}));
test('the decoded tar still enforces every indexed member digest mode link and closed universe',()=>fixture((f:any)=>{
 for(const field of ['sha256','mode','target']){const rows=new Map(f.rows as Map<string,any>),key=field==='target'?'node_modules/link':'node_modules/a';rows.set(key,{...rows.get(key),[field]:field==='mode'?0o755:field==='target'?'random':'0'.repeat(64)});expect(()=>f.inspect({rows})).toThrow();}
 const rows=new Map(f.rows);rows.delete('node_modules/random');expect(()=>f.inspect({rows})).toThrow();
 expect(()=>f.inspect({check(){throw Error('expired one deadline');}})).toThrow('expired');
}));

test('shared gzip reader verifies full bytes before random access and detaches indices/buffers',()=>fixture((f:any)=>{
 const index=structuredClone(f.index),reader=createGzipBlockSourceReader({archive:f.archive,index,check(){},readRange:(_name,offset,length)=>f.packed.subarray(offset,offset+length)});
 expect(()=>reader.assertComplete()).toThrow('complete');expect(()=>reader.readRange(limits.rangeBytes*2,1)).toThrow('sequential');
 index.blocks[0].offset=999;index.expanded.bytes=0;
 for(let offset=0;offset<reader.expanded.bytes;offset+=limits.rangeBytes)reader.readRange(offset,Math.min(limits.rangeBytes,reader.expanded.bytes-offset));
 reader.assertComplete();const first=reader.readRange(0,64),saved=Buffer.from(first);first.fill(0);expect(reader.readRange(0,64)).toEqual(saved);
 reader.readRange(reader.expanded.bytes-1,1);f.packed[0]^=1;expect(()=>reader.readRange(0,1)).toThrow('held gzip block bytes changed');
}));

/**
 * RC387 runtime profile: a real whole /app root decodes to 568,774,144 bytes, which is
 * above the shared source shard bound (512 MiB) that this reader uses by default. The
 * reader gains an OPTIONAL profile so only the runtime caller may pass the larger
 * central limits. The default path must still reject.
 *
 * No giant allocation: a highly compressible 600 MiB payload becomes a small gzip, and
 * it is produced block-by-block with the real gzip codec, so the geometry and digests
 * are genuine.
 */
function profileFixture(expectedBytes: number) {
  const base = path.resolve(import.meta.dir, '../../.test-data');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'gzip-profile-'));
  try {
    const code = [
      'import gzip, hashlib, json, pathlib, sys',
      'r = pathlib.Path(sys.argv[1]); size = int(sys.argv[2]); chunk = 65536',
      'blocks = []; packed_total = 0; expanded_off = 0',
      'body = bytes(chunk)',
      'out = open(r / "packed.bin", "wb")',
      'while expanded_off < size:',
      '    take = min(chunk, size - expanded_off)',
      '    block = gzip.compress(body[:take], compresslevel=6, mtime=0)',
      '    blocks.append(dict(offset=packed_total, bytes=len(block), expandedOffset=expanded_off, expandedBytes=take))',
      '    out.write(block); packed_total += len(block); expanded_off += take',
      'out.close()',
      'packed = (r / "packed.bin").read_bytes()',
      'di = hashlib.sha256()',
      'for i in range(size // chunk): di.update(bytes(chunk))',
      'rem = size % chunk',
      'if rem: di.update(bytes(rem))',
      'index = dict(schemaVersion=1, kind="source-tar-gzip-block-index",',
      '    archive=dict(path="stages/x/stdout.raw", bytes=len(packed), sha256=hashlib.sha256(packed).hexdigest()),',
      '    expanded=dict(bytes=size, sha256=di.hexdigest()), blocks=blocks)',
      '(r / "index.json").write_text(json.dumps(index))',
    ].join('\n');
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', code, root, String(expectedBytes)], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
    return {
      root,
      packed: fs.readFileSync(path.join(root, 'packed.bin')),
      index: JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')),
    };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

test('the runtime profile accepts a decoded archive above the shared source cap and hashes the real bytes', () => {
  // 600 MiB decoded: above limits.shardBytes, below limits.expandedBytes.
  const decoded = 600 * 1024 * 1024;
  const value = profileFixture(decoded);
  try {
    const archive = value.index.archive;
    const make = (sizeProfile?: any) => createGzipBlockSourceReader({
      archive, index: value.index,
      readRange: (_name, offset, length) => value.packed.subarray(offset, offset + length),
      check: () => {},
      ...(sizeProfile ? { sizeProfile } : {}),
    });
    // Default (shared source 512 MiB) MUST still reject this archive.
    expect(() => make()).toThrow(/expanded and retained shard bounds/u);
    // The runtime profile accepts it and the complete decoded digest is verified.
    const reader = make({ encodedBytes: limits.packedBytes, expandedBytes: limits.expandedBytes });
    // readRange is decoded-range access; drive the FULL decoded archive so the reader
    // verifies every gzip block and both complete digests (no giant allocation: the
    // source is read piecewise from the real compressed bytes).
    let offset = 0;
    while (offset < decoded) {
      const length = Math.min(limits.rangeBytes, decoded - offset);
      expect(reader.readRange(offset, length).length).toBe(length);
      offset += length;
    }
    expect(() => reader.assertComplete()).not.toThrow();
    expect(reader.expanded.bytes).toBe(decoded);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
}, 120_000);

test('the runtime profile is still bounded: a decoded archive above expandedBytes is refused', () => {
  // Encode only a small prefix but CLAIM an enormous expanded size to prove the bound.
  const value = profileFixture(1024 * 1024);
  try {
    const inflated = structuredClone(value.index);
    inflated.expanded.bytes = limits.expandedBytes + 1;
    const reader = () => createGzipBlockSourceReader({
      archive: { ...value.index.archive },
      index: inflated,
      readRange: (_n, o, l) => value.packed.subarray(o, o + l),
      check: () => {},
      sizeProfile: { encodedBytes: limits.packedBytes, expandedBytes: limits.expandedBytes },
    });
    expect(reader).toThrow(/expanded and retained shard bounds/u);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test('one encoded page window keeps two passes on the SAME reader inside the unchanged call budget', () => {
  // REAL owned originals, no giant allocations: ONE compressed block is generated and
  // reused 1100 times, so the encoded archive is a valid concatenation of identical
  // gzip members whose index offsets are still distinct and contiguous. Expanded bytes
  // are hashed as a streaming hash of the same reusable 64KiB plain page.
  const base = path.resolve(import.meta.dir, '../../.test-data');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'gzip-page-window-'));
  const owners: Array<{ close(): void }> = [];
  try {
    const BLOCKS = 1100;                 // > 1024 blocks => old per-block shape blows the cap
    const PAGE = limits.rangeBytes;      // each block legitimately expands to a full page
    const plain = Buffer.alloc(PAGE, 0x61);
    const member = gzipSync(plain);      // one reusable member

    const blockCount = member.length;
    const encodedBytes = blockCount * BLOCKS;
    const expandedBytes = PAGE * BLOCKS;

    // Streaming expanded hash over the SAME reusable page, BLOCKS times.
    const expandedHash = createHash('sha256');
    for (let i = 0; i < BLOCKS; i++) expandedHash.update(plain);

    const file = path.join(root, 'archive.gz');
    // Write the encoded archive without holding it all: reuse the member buffer.
    const fdOut = fs.openSync(file, 'w');
    try { for (let i = 0; i < BLOCKS; i++) fs.writeSync(fdOut, member); } finally { fs.closeSync(fdOut); }
    const encodedSha = sha(fs.readFileSync(file));
    const encodedSize = fs.statSync(file).size;
    expect(encodedSize).toBe(encodedBytes);

    const archive = { path: 'runtime-app/stdout.raw', bytes: encodedSize, sha256: encodedSha };
    const blocks = Array.from({ length: BLOCKS }, (_unused, i) => ({
      offset: i * blockCount, bytes: blockCount, expandedOffset: i * PAGE, expandedBytes: PAGE,
    }));
    const index = { schemaVersion: 1, kind: 'source-tar-gzip-block-index', archive,
      expanded: { bytes: expandedBytes, sha256: expandedHash.digest('hex') }, blocks };

    const callCap = Math.max(1024, Math.ceil(encodedSize / limits.rangeBytes) * 8);
    const pagesPerPass = Math.ceil(encodedSize / limits.rangeBytes);
    // OLD shape: one original read per block per pass.
    expect(BLOCKS * 2 > callCap).toBe(true);

    // (1) OLD SHAPE must ACTUALLY fail against a real bound file, not merely by arithmetic.
    const oldOwner = openBoundOriginalFile(file, { path: archive.path, bytes: encodedSize, sha256: encodedSha });
    owners.push(oldOwner);
    let oldReads = 0;
    expect(() => {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const row of blocks) {
          oldReads += 1;
          oldOwner.readRange(row.offset, Math.min(limits.rangeBytes, row.bytes));
        }
      }
    }).toThrow(/cumulative original range budget exceeded/u);
    oldOwner.close();
    owners.pop();

    // (2) NEW SHAPE: ONE bound file + ONE reader, readWhole twice on the SAME handles.
    const owner = openBoundOriginalFile(file, { path: archive.path, bytes: encodedSize, sha256: encodedSha });
    owners.push(owner);
    const counter = { reads: 0 };
    const reader = createGzipBlockSourceReader({ archive, index, check: () => owner.assertCurrent(),
      readRange: (_n: string, o: number, l: number) => { counter.reads += 1; return owner.readRange(o, l); } });
    const readWhole = () => {
      let done = 0;
      while (done < expandedBytes) {
        const step = Math.min(limits.rangeBytes, expandedBytes - done);
        reader.readRange(done, step);
        done += step;
      }
    };
    readWhole();
    reader.assertComplete();
    readWhole();
    reader.assertComplete();
    // Two passes over the SAME handles: no budget reset between them.
    expect(counter.reads <= callCap).toBe(true);
    // With this geometry each pass needs exactly one fetch per encoded page.
    expect(counter.reads).toBe(2 * pagesPerPass);

    // (3) A cached expanded page is still revocation-checked on a hit, and public buffers
    // stay private: mutate what the caller received, then reread the same cached page.
    const borrowed = reader.readRange(0, PAGE);
    const original = Buffer.from(borrowed);
    borrowed.fill(0xff);
    expect(reader.readRange(0, PAGE)).toEqual(original);
    owner.close();
    owners.pop();
    expect(() => reader.readRange(0, PAGE)).toThrow();
  } finally {
    for (const owner of owners) { try { owner.close(); } catch { /* already closed */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
