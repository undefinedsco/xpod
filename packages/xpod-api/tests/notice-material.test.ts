import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {attachPhysicalNotices} from '../../../scripts/lib/physical-module-notices';
for(const drift of [false,true])test('notice original objects are actual-byte-bound, drift='+drift,()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'terms-'));
 const put=(f:string,bytes:string)=>{const p=path.join(root,f);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,bytes);};const hash=(b:string)=>createHash('sha256').update(b).digest('hex');
 try {
  const manifest=JSON.stringify({name:'fixture',version:'1.0.0',license:'MIT'});put('stage/node_modules/fixture/package.json',manifest);put('stage/provenance/packages/fixture.json',JSON.stringify({name:'fixture',version:'1.0.0',path:'node_modules/fixture',files:[{path:'package.json',bytes:Buffer.byteLength(manifest),sha256:hash(manifest)}]}));
  const original='actual original terms';const digest=hash(original);put('supplements/objects/'+digest+'.txt',drift?'changed original terms':original);put('supplements/index.json',JSON.stringify({schemaVersion:1,entries:[{name:'fixture',version:'1.0.0',provenance:{noticeUrl:'https://example.org/'+ '1'.repeat(40)+'/LICENSE',gitHead:'1'.repeat(40)},files:[{sourcePath:'LICENSE',object:'objects/'+digest+'.txt',sha256:digest}]}]}));
  const stage=path.join(root,'stage');if(drift){assert.throws(()=>attachPhysicalNotices(stage,[path.join(root,'supplements')]),/hash mismatch/);assert.equal(existsSync(path.join(stage,'provenance/terms')),false);}else{attachPhysicalNotices(stage,[path.join(root,'supplements')]);const material=JSON.parse(readFileSync(path.join(stage,'provenance/terms/index.json'),'utf8'));assert.equal(material.legalClearance,false);assert.equal(material.missingNamedOriginalTerms.length,0);assert.throws(()=>verifyPhysicalNotices(stage,true),/requires retained registry originals/);assert.equal(readFileSync(path.join(stage,'provenance/terms/objects',digest+'.txt'),'utf8'),original);}
 } finally {rmSync(root,{recursive:true,force:true});}
});

import {completeEmbeddedNotice,verifyPhysicalNotices} from '../../../scripts/lib/physical-module-notices';
test('embedded README requires complete unchanged normative terms and original holder',()=>{
 const template=readFileSync('packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt','utf8');
 const terms=template.replace('Copyright (c) <year> <copyright holders>','Copyright (c) 2024 Actual Authors');
 const readme=Buffer.from('# Package\nUnrelated package introduction.\n## License\n'+terms);
 assert.equal(completeEmbeddedNotice(readme,'MIT'),true);
 assert.equal(completeEmbeddedNotice(Buffer.from('License (MIT)\n-------------\n'+terms),'MIT'),true);
 assert.equal(completeEmbeddedNotice(Buffer.from('#### LICENSE\nThis software is licensed under the MIT License.\n\n'+terms),'MIT'),true);
 for(const bad of ['## License\nMIT','## License\nSee https://example.org/LICENSE','## License\n'+template,'## License\n'+terms+'\nRedistribution prohibited.','## License\n'+terms.replace('free of charge','for a fee'),'## License\n'+terms+'\n## Other\nRestriction','SPDX-License-Identifier: Proprietary\n## License\n'+terms])assert.equal(completeEmbeddedNotice(Buffer.from(bad),'MIT'),false);
 const singleQuoted=terms.replaceAll('"Software"',"'Software'").replaceAll('"AS IS"',"'AS IS'");
 assert.equal(completeEmbeddedNotice(Buffer.from('## Licence\n(The MIT License)\n\n'+singleQuoted),'MIT'),true);
 assert.equal(completeEmbeddedNotice(Buffer.from('License\n-------\n\n(The MIT License)\n\n'+singleQuoted.replace("(the 'Software')","(the\n'Software')")+'\n\n[rfc]: http://example.org/public-rfc\n'),'MIT'),true);
 assert.equal(completeEmbeddedNotice(Buffer.from('## Licence\n'+singleQuoted+'\n\n[rfc]: http://user:secret@example.org/rfc\n'),'MIT'),false);
 assert.equal(completeEmbeddedNotice(Buffer.from('## Licence\n'+singleQuoted.replace('free of charge','for a fee')),'MIT'),false);
 assert.equal(completeEmbeddedNotice(Buffer.from('## Licence\n'+singleQuoted+'\nRedistribution prohibited.'),'MIT'),false);
 assert.equal(completeEmbeddedNotice(readme,'Apache-2.0'),false);
});
test('complete README and COPYRIGHT remain original package bytes, inventory drift rejects',()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'embedded-'));
 try{
  const stage=path.join(root,'stage'),pkg=path.join(stage,'node_modules/fixture');mkdirSync(pkg,{recursive:true});mkdirSync(path.join(stage,'provenance/packages'),{recursive:true});
  const template=readFileSync('packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt','utf8');
  const files={'package.json':JSON.stringify({name:'fixture',version:'1.0.0',license:'MIT'}),'README.md':'## License\n'+template.replace('Copyright (c) <year> <copyright holders>','Copyright (c) 2024 Actual Authors'),'COPYRIGHT':'Copyright (c) 2024 Actual Authors'};
  for(const [name,bytes]of Object.entries(files))writeFileSync(path.join(pkg,name),bytes);
  writeFileSync(path.join(stage,'provenance/packages/fixture.json'),JSON.stringify({name:'fixture',version:'1.0.0',path:'node_modules/fixture',files:Object.entries(files).map(([name,bytes])=>({path:name,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')}))}));
  attachPhysicalNotices(stage,[]);verifyPhysicalNotices(stage,true);
  const index=JSON.parse(readFileSync(path.join(stage,'provenance/terms/index.json'),'utf8'));assert.equal(index.legalClearance,false);assert.equal(index.entries[0].originals.length,2);
  writeFileSync(path.join(pkg,'README.md'),'changed');assert.throws(()=>verifyPhysicalNotices(stage),/inventory drift/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

import {gzipSync} from 'node:zlib';
function registryFixture(files:Record<string,string>,prefix='package/'):Buffer{
 const blocks:Buffer[]=[];
 for(const [name,text]of Object.entries(files)){const bytes=Buffer.from(text),header=Buffer.alloc(512);header.write(prefix+name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}
 return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
for(const defect of ['none','member','version','sri','missing-archive','package-json-only'])test('registry supplement actual full archive binding '+defect,()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'registry-'));
 const sha=(b:Buffer|string,algorithm='sha256')=>createHash(algorithm).update(b).digest('hex');
 const put=(name:string,bytes:Buffer|string)=>{const dest=path.join(root,name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes);};
 try{
  const manifest=JSON.stringify({name:'fixture',version:'1.0.0'}),terms='original retained terms';put('stage/node_modules/fixture/package.json',manifest);put('stage/provenance/packages/fixture.json',JSON.stringify({name:'fixture',version:'1.0.0',path:'node_modules/fixture',files:[{path:'package.json',bytes:Buffer.byteLength(manifest),sha256:sha(manifest)}]}));
  const archive=registryFixture({'package.json':defect==='version'?JSON.stringify({name:'fixture',version:'2.0.0'}):manifest,'LICENSE':defect==='member'?'other terms':terms}),integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
  const provenance={gitHead:'1'.repeat(40),noticeUrl:'https://example.org/'+ '1'.repeat(40)+'/LICENSE',archiveUrl:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',archiveIntegrity:integrity};
  const metadata=JSON.stringify({name:'fixture',version:'1.0.0',gitHead:provenance.gitHead,dist:{integrity,tarball:provenance.archiveUrl}});put('supp/archive.tgz',archive);put('supp/metadata.json',metadata);put('supp/objects/'+sha(terms)+'.txt',terms);
  const ref=(name:string,b:Buffer|string)=>({path:name,bytes:Buffer.byteLength(b),sha256:sha(b)});
  const selectedTerms=defect==='package-json-only'?manifest:terms;put('supp/objects/'+sha(selectedTerms)+'.txt',selectedTerms);
  put('supp/index.json',JSON.stringify({schemaVersion:1,entries:[{name:'fixture',version:'1.0.0',provenance,registryOriginals:defect==='missing-archive'?undefined:{archive:ref('archive.tgz',archive),metadata:ref('metadata.json',metadata)},files:[{sourcePath:defect==='package-json-only'?'package.json':'LICENSE',object:'objects/'+sha(selectedTerms)+'.txt',sha256:sha(selectedTerms)}]}]}));
  const lock=Buffer.from(JSON.stringify({lockfileVersion:1,packages:{fixture:['fixture@1.0.0',defect==='sri'?'sha512-'+Buffer.alloc(64).toString('base64'):integrity]}}));
  if(defect==='none'){
   const stage=path.join(root,'stage');attachPhysicalNotices(stage,[path.join(root,'supp')],lock);verifyPhysicalNotices(stage,true);
   const indexPath=path.join(stage,'provenance/terms/index.json'),original=readFileSync(indexPath,'utf8');
   for(const remove of ['lock','archive','metadata']){const changed=JSON.parse(original);if(remove==='lock')delete changed.registryLockOriginal;else delete changed.entries[0].supplements[0].registryOriginals[remove];writeFileSync(indexPath,JSON.stringify(changed));assert.throws(()=>verifyPhysicalNotices(stage,true));}
   writeFileSync(indexPath,original);verifyPhysicalNotices(stage,true);
  }else{assert.throws(()=>attachPhysicalNotices(path.join(root,'stage'),[path.join(root,'supp')],lock));assert.equal(existsSync(path.join(root,'stage/provenance/terms')),false);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

for(const defect of ['none','commit','prefix','scope','other-package','native','archive-sha','missing-archive','unknown-origin','wrong-archive-prefix'])test('external source original is a separate exact commit archive/member '+defect,()=>{
 const base=path.resolve('.test-data/api-stage-tests');mkdirSync(base,{recursive:true});const root=mkdtempSync(path.join(base,'source-'));
 const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');const put=(name:string,b:Buffer|string)=>{const dest=path.join(root,name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,b);};
 try{
  const commit='1'.repeat(40),repository='https://github.com/example/fixture',license='Original complete upstream LICENSE bytes';
  const manifest=JSON.stringify({name:'fixture',version:'1.0.0',license:'MIT',...(defect==='native'?{os:['linux'],cpu:['arm64']}:{})});put('stage/node_modules/fixture/package.json',manifest);put('stage/provenance/packages/fixture.json',JSON.stringify({name:'fixture',version:'1.0.0',path:'node_modules/fixture',files:[{path:'package.json',bytes:Buffer.byteLength(manifest),sha256:sha(manifest)}]}));
  const archive=registryFixture({'package.json':manifest}),integrity='sha512-'+createHash('sha512').update(archive).digest('base64'),metadata=JSON.stringify({name:'fixture',version:'1.0.0',gitHead:commit,repository:{url:repository+'.git'},dist:{integrity,tarball:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz'}});
  const source=registryFixture({'LICENSE':license,'other/LICENSE':license},(defect==='prefix'?'unrelated-': 'fixture-')+commit+'/');put('supp/registry.tgz',archive);put('supp/metadata.json',metadata);put('supp/source.tgz',source);put('supp/objects/'+sha(license)+'.txt',license);
  const ref=(name:string,b:Buffer|string)=>({path:name,bytes:Buffer.byteLength(b),sha256:sha(b)});
  put('supp/index.json',JSON.stringify({schemaVersion:1,entries:[{name:'fixture',version:'1.0.0',provenance:{gitHead:commit,noticeUrl:repository+'/blob/'+commit+'/LICENSE',archiveUrl:'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',archiveIntegrity:integrity},registryOriginals:{archive:ref('registry.tgz',archive),metadata:ref('metadata.json',metadata)},sourceOriginals:{repository,commit:defect==='commit'?'2'.repeat(40):commit,url:'https://codeload.github.com/example/fixture/tar.gz/'+commit,packageDirectory:defect==='scope'?'other':'',...(defect==='wrong-archive-prefix'?{archivePrefix:'other-'+commit+'/'}:{}),archive:defect==='missing-archive'?undefined:{...ref('source.tgz',source),...(defect==='archive-sha'?{sha256:'0'.repeat(64)}:{})}},files:[{sourceOrigin:defect==='unknown-origin'?'untrusted-origin':'source-archive',sourcePath:defect==='other-package'?'other/LICENSE':'LICENSE',object:'objects/'+sha(license)+'.txt',sha256:sha(license)}]}]}));
  const lock=Buffer.from(JSON.stringify({lockfileVersion:1,packages:{fixture:['fixture@1.0.0',integrity]}})),stage=path.join(root,'stage');
  if(defect==='none'||defect==='native'){
   attachPhysicalNotices(stage,[path.join(root,'supp')],lock);verifyPhysicalNotices(stage);
   const index=JSON.parse(readFileSync(path.join(stage,'provenance/terms/index.json'),'utf8'));assert.equal(index.legalClearance,false);
   if(defect==='native'){assert.equal(index.missingNamedOriginalTerms.length,1);assert.equal(index.entries[0].supplements[0].nativeContentsTermsPending,true);assert.throws(()=>verifyPhysicalNotices(stage,true),/incomplete/);}else{verifyPhysicalNotices(stage,true);assert.equal(index.missingNamedOriginalTerms.length,0);const originalObject=index.entries[0].supplements[0].files[0].object;writeFileSync(path.join(stage,'provenance/terms',originalObject),Buffer.alloc(4*1024**2+1));assert.throws(()=>verifyPhysicalNotices(stage,true),/Notice original byte budget/);writeFileSync(path.join(stage,'provenance/terms',originalObject),license);const sourceRef=index.entries[0].supplements[0].sourceOriginals.archive;writeFileSync(path.join(stage,'provenance/terms',sourceRef.object),'changed');assert.throws(()=>verifyPhysicalNotices(stage,true),/drift/);}
  }else{assert.throws(()=>attachPhysicalNotices(stage,[path.join(root,'supp')],lock));assert.equal(existsSync(path.join(stage,'provenance/terms')),false);}
 }finally{rmSync(root,{recursive:true,force:true});}
});
