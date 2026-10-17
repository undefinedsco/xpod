import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lazyZipOriginals,zipCacheEvictions } from '../../scripts/lib/independent-admission/lazy-zip-originals';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('real ZIP originals project on demand, evict under the byte bound and revoke after close',()=>{
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'lazy-zip-test-'));
  try {
    const archive=path.join(root,'original.zip'), cache=path.join(root,'cache');fs.mkdirSync(cache);
    // Five 4MiB entries exceed the metadata cache by one entry; no large fixture.
    const result=spawnSync('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED); [z.writestr(str(i)+'.json',bytes([i])*4194304) for i in range(5)]; z.close()",archive]);
    expect(result.status).toBe(0);
    const members=Array.from({length:5},(_,i)=>({path:i+'.json',bytes:4194304,sha256:sha(Buffer.alloc(4194304,i))}));
    const original=fs.readFileSync(archive),reader=lazyZipOriginals({archivePath:archive,archiveSha256:sha(original),root:cache,members});
    expect(fs.readdirSync(cache)).toHaveLength(0);
    for(let i=0;i<5;i++) expect(reader.readRange(i+'.json',3,3)).toEqual(Buffer.alloc(3,i));
    expect(reader.cacheBytes()).toBe(16*1024**2);
    expect(fs.readdirSync(cache)).toHaveLength(4);
    expect(reader.readRange('0.json',0,1)[0]).toBe(0);
    reader.assertRetainedOriginal();reader.close();reader.close();
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.readdirSync(cache)).toHaveLength(0);
    expect(()=>reader.readRange('0.json',0,1)).toThrow();
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('wrong member digest and later archive mutation fail without granting a reader',()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lazy-zip-negative-'));
  try {
    const archive=path.join(root,'original.zip'),cache=path.join(root,'cache');fs.mkdirSync(cache);
    expect(spawnSync('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('a','hello');z.close()",archive]).status).toBe(0);
    const reader=lazyZipOriginals({archivePath:archive,archiveSha256:sha(fs.readFileSync(archive)),root:cache,members:[{path:'a',bytes:5,sha256:'0'.repeat(64)}]});
    expect(()=>reader.readRange('a',0,1)).toThrow();expect(fs.readdirSync(cache)).toHaveLength(0);
    fs.appendFileSync(archive,'changed');
    expect(()=>reader.assertRetainedOriginal()).toThrow();reader.close();
    expect(fs.existsSync(archive)).toBe(true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('large-member LRU capacity is independently 512MiB, without allocating a huge fixture',()=>{
 const MiB=1024**2;
 const rows=[{key:'metadata',bytes:4*MiB,small:true},{key:'first',bytes:300*MiB,small:false},{key:'second',bytes:200*MiB,small:false}];
 expect(zipCacheEvictions(rows,{bytes:256*MiB,small:false,capacity:512*MiB})).toEqual(['first']);
 expect(zipCacheEvictions(rows,{bytes:512*MiB,small:false,capacity:512*MiB})).toEqual(['first','second']);
 expect(()=>zipCacheEvictions([],{bytes:513*MiB,small:false,capacity:512*MiB})).toThrow('capacity');
});
test('idle wall time does not spend the bounded projection I/O budget',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lazy-idle-')),clock=Date.now;
 let reader:ReturnType<typeof lazyZipOriginals>|undefined;
 try{
  const archive=path.join(root,'original.zip'),cache=path.join(root,'cache');fs.mkdirSync(cache);
  expect(spawnSync('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('a','hello');z.close()",archive]).status).toBe(0);
  reader=lazyZipOriginals({archivePath:archive,archiveSha256:sha(fs.readFileSync(archive)),root:cache,members:[{path:'a',bytes:5,sha256:sha(Buffer.from('hello'))}]});
  Date.now=()=>clock()+3600000;
  expect(reader.readRange('a',0,5)).toEqual(Buffer.from('hello'));
 }finally{Date.now=clock;reader?.close();fs.rmSync(root,{recursive:true,force:true});}
});
