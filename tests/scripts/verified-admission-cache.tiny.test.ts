import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lazyZipOriginals} from '../../scripts/lib/independent-admission/lazy-zip-originals';
import {test,expect} from 'bun:test';
import {verifiedAdmissionCache} from '../../scripts/lib/independent-admission/verified-admission-cache';
test('only verified reports survive with exact opaque bindings; sets deduplicate by handle',()=>{
 const cache=verifiedAdmissionCache<{status:string;facts:{verified:boolean}}>(),artifact={},source={},consumer={},native={},legal={},related={};
 const keys=[source,consumer,native,legal],sets=[[related],[legal]];
 const pending={status:'pending',facts:{verified:false}};
 cache.remember(artifact,'legal',keys,sets,pending);expect(cache.get(artifact,'legal',keys,sets)).toBeUndefined();
 const report={status:'verified',facts:{verified:true}};const saved=cache.remember(artifact,'legal',keys,sets,report);report.facts.verified=false;
 expect(saved.facts.verified).toBe(true);expect(Object.isFrozen(saved.facts)).toBe(true);
 expect(cache.get(artifact,'legal',keys,[[related,related],[legal]])).toBe(saved);
 for(const index of [0,1,2,3]){const changed=[...keys];changed[index]={};expect(cache.get(artifact,'legal',changed,sets)).toBeUndefined();}
 expect(cache.get({},'legal',keys,sets)).toBeUndefined();expect(cache.get(artifact,'source',keys,sets)).toBeUndefined();
 expect(cache.get(artifact,'legal',keys,[[related,{}],[legal]])).toBeUndefined();
});

test('saved verified facts cannot bypass a real original ZIP changed after projection compaction',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'verified-custody-')),artifact={},source={};
 let originals:ReturnType<typeof lazyZipOriginals>|undefined;
 try{
  const archive=path.join(root,'original.zip'),projection=path.join(root,'cache');fs.mkdirSync(projection);
  expect(spawnSync('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('a','hello');z.close()",archive]).status).toBe(0);
  const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  originals=lazyZipOriginals({archivePath:archive,archiveSha256:digest(fs.readFileSync(archive)),root:projection,members:[{path:'a',bytes:5,sha256:digest(Buffer.from('hello'))}]});
  expect(originals.readRange('a',0,5)).toEqual(Buffer.from('hello'));
  const cache=verifiedAdmissionCache<{status:string}>();cache.remember(artifact,'source',[source],[],{status:'verified'});
  const guard=originals.assertRetainedOriginal;originals.close();
  expect(cache.get(artifact,'source',[source],[],guard)?.status).toBe('verified');
  fs.appendFileSync(archive,'tampered');
  expect(()=>cache.get(artifact,'source',[source],[],guard)).toThrow('identity');
  expect(fs.existsSync(archive)).toBe(true);
 }finally{originals?.close();fs.rmSync(root,{recursive:true,force:true});}
});
