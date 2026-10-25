import {test,expect} from 'bun:test';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {inspectSourceOriginalTar,inspectGzipBlockSourceOriginalTar,createGzipBlockSourceReader} from '../../scripts/lib/independent-admission/source-original-tar';
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
