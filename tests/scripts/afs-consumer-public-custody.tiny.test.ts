import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reserveAfsConsumerEvidenceLayout} from '../../scripts/lib/independent-admission/afs-consumer-public-custody';
const base=path.resolve(import.meta.dir,'../../.test-data');
const ref=(name:string,body:string)=>({path:name,mode:0o644,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});
function fixture(){fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'afs-public-custody-'));const layout=reserveAfsConsumerEvidenceLayout(path.join(root,'public'));fs.mkdirSync(layout.privateDirectory);return {root,layout};}
test('checked original move keeps inode and leaves private scene credentials outside public',()=>{
 const {root,layout}=fixture();try{
 fs.writeFileSync(path.join(layout.privateDirectory,'result.json'),'{}');fs.mkdirSync(path.join(layout.privateDirectory,'auth'));fs.writeFileSync(path.join(layout.privateDirectory,'auth/credentials.json'),'private-marker');
 const inode=fs.statSync(path.join(layout.privateDirectory,'result.json')).ino;
 const result=layout.publish([ref('result.json','{}')]);
 expect(result.originals.length).toBe(1);expect(fs.statSync(path.join(layout.publicDirectory,'result.json')).ino).toBe(inode);
 expect(fs.existsSync(path.join(layout.privateDirectory,'result.json'))).toBe(false);expect(fs.existsSync(path.join(layout.publicDirectory,'auth'))).toBe(false);expect(fs.readFileSync(path.join(layout.privateDirectory,'auth/credentials.json'),'utf8')).toBe('private-marker');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('changed selected bytes fail before a public directory exists',()=>{
 const {root,layout}=fixture();try{fs.writeFileSync(path.join(layout.privateDirectory,'result.json'),'changed');expect(()=>layout.publish([ref('result.json','{}')])).toThrow();expect(fs.existsSync(layout.publicDirectory)).toBe(false);expect(fs.existsSync(path.join(layout.privateDirectory,'result.json'))).toBe(true);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('partial rename failure retains both original locations and refuses completion',()=>{
 const {root,layout}=fixture(),rename=fs.renameSync;try{
 fs.writeFileSync(path.join(layout.privateDirectory,'one.raw'),'one');fs.writeFileSync(path.join(layout.privateDirectory,'two.raw'),'two');let calls=0;
 fs.renameSync=((...args:Parameters<typeof rename>)=>{if(++calls===2)throw Error('simulated rename failure');return rename(...args);}) as typeof rename;
 expect(()=>layout.publish([ref('one.raw','one'),ref('two.raw','two')])).toThrow('Partial AFS public projection retained');
 expect(fs.readFileSync(path.join(layout.publicDirectory,'one.raw'),'utf8')).toBe('one');expect(fs.readFileSync(path.join(layout.privateDirectory,'two.raw'),'utf8')).toBe('two');
 }finally{fs.renameSync=rename;fs.rmSync(root,{recursive:true,force:true});}
});
