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
  const stage=path.join(root,'stage');if(drift){assert.throws(()=>attachPhysicalNotices(stage,[path.join(root,'supplements')]),/hash mismatch/);assert.equal(existsSync(path.join(stage,'provenance/terms')),false);}else{attachPhysicalNotices(stage,[path.join(root,'supplements')]);const material=JSON.parse(readFileSync(path.join(stage,'provenance/terms/index.json'),'utf8'));assert.equal(material.legalClearance,false);assert.equal(material.missingNamedOriginalTerms.length,0);assert.equal(readFileSync(path.join(stage,'provenance/terms/objects',digest+'.txt'),'utf8'),original);}
 } finally {rmSync(root,{recursive:true,force:true});}
});
