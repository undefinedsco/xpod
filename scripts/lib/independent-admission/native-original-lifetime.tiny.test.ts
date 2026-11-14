import {test,expect} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {nativeOriginalLifetime} from './native-original-lifetime';
import {openBoundOriginalFile} from './bound-original-file';
import {createHash} from 'node:crypto';
test('compact closes same-file reader, preserves unique ZIP, retains facts and is idempotent',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'native-life-'));
 try{
 const original=path.join(root,'original.zip');fs.writeFileSync(original,'original');
 const snapshot=path.join(root,'projection');fs.mkdirSync(snapshot);const file=path.join(snapshot,'source.tar');fs.writeFileSync(file,'abc');
 const reader=openBoundOriginalFile(file,{path:'source.tar',bytes:3,sha256:createHash('sha256').update('abc').digest('hex')});
 const life=nativeOriginalLifetime({snapshot,closeReaders:()=>reader.close(),verifyRetainedOriginal(){expect(fs.readFileSync(original,'utf8')).toBe('original');}});
 life.assertReadable();expect(reader.readRange(0,3).toString()).toBe('abc');
 expect(life.compact()).toBe(true);expect(life.compact()).toBe(false);
 expect(()=>life.assertReadable()).toThrow('compacted');expect(()=>reader.readRange(0,1)).toThrow();
 expect(fs.existsSync(snapshot)).toBe(false);expect(fs.existsSync(original)).toBe(true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing retained original refuses compaction and keeps projection readable',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'native-life-'));
 try{let closed=false;const life=nativeOriginalLifetime({snapshot:root,closeReaders(){closed=true;},verifyRetainedOriginal(){throw Error('missing unique ZIP');}});
 expect(()=>life.compact()).toThrow('missing unique ZIP');life.assertReadable();expect(closed).toBe(false);expect(fs.existsSync(root)).toBe(true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
