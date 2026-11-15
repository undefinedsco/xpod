import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const child=vi.hoisted(()=>({timeouts:[] as number[]}));
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawnSync:vi.fn((_file,_args,options)=>{child.timeouts.push(options.timeout);return {error:new Error('fixture timeout'),status:null,signal:'SIGTERM',stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};})}));
import {lazyZipOriginals} from '../../scripts/lib/independent-admission/lazy-zip-originals';
import {openBoundOriginalFile} from '../../scripts/lib/independent-admission/bound-original-file';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
describe('original read remaining budget',()=>{
 it('passes the observer remaining timeout into the single fixed ZIP extractor',()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'zip-timeout-'));
  try{const archive=path.join(root,'original.zip'),cache=path.join(root,'cache');fs.mkdirSync(cache);execFileSync('python3',['-c',"import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('a','hello');z.close()",archive]);
   const reader=lazyZipOriginals({archivePath:archive,archiveSha256:sha(fs.readFileSync(archive)),root:cache,members:[{path:'a',bytes:5,sha256:sha(Buffer.from('hello'))}]});
   expect(()=>reader.readRange('a',0,1,{remainingMilliseconds:()=>17000})).toThrow();expect(child.timeouts).toEqual([17000]);expect(reader.cacheBytes()).toBe(0);expect(fs.readdirSync(cache)).toEqual([]);reader.close();
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('rechecks the same observer window inside full FD hashing',()=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fd-timeout-'));
  try{const file=path.join(root,'a');fs.writeFileSync(file,'hello');let calls=0;expect(()=>openBoundOriginalFile(file,{path:'a',bytes:5,sha256:sha(Buffer.from('hello'))},{remainingMilliseconds:()=>++calls===1?1:0})).toThrow('observer original deadline');expect(calls).toBe(2);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
 });
});
