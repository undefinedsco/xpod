import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {openAfsConsumerDirectoryOriginals} from '../../scripts/lib/independent-admission/afs-consumer-directory-originals';
import {reserveAfsConsumerEvidenceLayout} from '../../scripts/lib/independent-admission/afs-consumer-public-custody';
import {finalizeAfsConsumerEvidence} from '../../scripts/lib/independent-admission/afs-consumer-finalization';
const base=path.resolve(import.meta.dir,'../../.test-data');
function fixture(){fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'afs-context-finalization-'));const layout=reserveAfsConsumerEvidenceLayout(path.join(root,'public'));fs.mkdirSync(layout.privateDirectory);return {root,layout};}
test('private local index excludes credential/hidden/link siblings and revokes changed files',()=>{
 const {root,layout}=fixture();try{
 fs.writeFileSync(path.join(layout.privateDirectory,'result.json'),'{}');fs.mkdirSync(path.join(layout.privateDirectory,'auth'));fs.writeFileSync(path.join(layout.privateDirectory,'auth/credentials.json'),'never-index');fs.mkdirSync(path.join(layout.privateDirectory,'.private-originals'));fs.writeFileSync(path.join(layout.privateDirectory,'.private-originals/secret'),'never-index');fs.symlinkSync('result.json',path.join(layout.privateDirectory,'linked.json'));
 const originals=openAfsConsumerDirectoryOriginals(layout.privateDirectory,Date.now()+30000);
 try{expect(originals.members.map(row=>row.path)).toEqual(['result.json']);expect(originals.readOriginal('result.json',16).toString()).toBe('{}');expect(()=>originals.readOriginalRange('result.json',0,65537)).toThrow();fs.writeFileSync(path.join(layout.privateDirectory,'result.json'),'[]');expect(()=>originals.readOriginal('result.json',16)).toThrow();}finally{originals.close();}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('caller passed flags without genuine AFS originals never create public evidence',()=>{
 const {root,layout}=fixture();try{
 fs.writeFileSync(path.join(layout.privateDirectory,'result.json'),JSON.stringify({status:'passed',realConsumerValidated:true,allProfilesVerified:true}));
 expect(()=>finalizeAfsConsumerEvidence({layout,deadline:Date.now()+30000,stage:'prepublish',product:{package:'@undefineds.co/xpod-afs-linux-x64',sourceSha:'a'.repeat(40),target:'linux-x64'} as any,productMembers:[],tools:[]})).toThrow('AFS fixed originals pending');
 expect(fs.existsSync(layout.publicDirectory)).toBe(false);expect(fs.existsSync(path.join(layout.privateDirectory,'result.json'))).toBe(true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
