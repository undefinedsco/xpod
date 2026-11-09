import { API_BUILD_INTEGRATION_TIMEOUT_MS } from './repo-root';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyApiSourcekits } from '../scripts/sourcekit';
import { deduplicateApiSourceRoots, writeApiSourcekit, verifyApiSourcekitRoots, type ApiSourceRoot } from '../scripts/sourcekit-producer';

test('identical whole distributions share one source copy and every physical origin is revalidated', () => {
  const parent=path.resolve('.test-data/api-source-origin-dedup');fs.mkdirSync(parent,{recursive:true});const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'case-')));
  const canonicalFiles=['source.ts'];
  const make=(name:string,version='1.0.0',body='original',mode=0o644)=>{fs.mkdirSync(base+'/producer/'+name,{recursive:true});const ownerPath='producer/'+name+'/package.json',ownerBody=JSON.stringify({dependencies:{'same-package':version}});fs.writeFileSync(base+'/'+ownerPath,ownerBody);canonicalFiles.push(ownerPath);const directory=base+'/'+name;fs.mkdirSync(directory);fs.writeFileSync(directory+'/package.json',JSON.stringify({name:'same-package',version}));fs.writeFileSync(directory+'/source.js',body);fs.chmodSync(directory+'/source.js',mode);return {directory,prefix:'physical/'+name,owners:[{kind:'declaration' as const,from:ownerPath,sha256:createHash('sha256').update(ownerBody).digest('hex'),specifier:'same-package'}]};};
  try{
    fs.writeFileSync(base+'/source.ts','canonical original');
    const first=make('a'),second=make('b'),version=make('c','2.0.0'),content=make('d','1.0.0','changed'),mode=make('e','1.0.0','original',0o755);
    const physical:ApiSourceRoot[]=[{directory:base,prefix:'canonical',files:canonicalFiles},first,second,version,content,mode];const roots=deduplicateApiSourceRoots(physical);assert.equal(roots.filter(root=>!root.files).length,4);
    const shared=roots.find(root=>root.origins?.length===2)!;assert(shared);assert.deepEqual(shared.origins!.map(row=>row.directory),[first.directory,second.directory]);assert.equal(shared.origins![0].owners[0].from,'producer/a/package.json');assert.equal(shared.origins![1].owners[0].from,'producer/b/package.json');
    const {kit,budget}=writeApiSourcekit(base+'/archive',roots,0);assert.equal(budget.sourceMembers,15);assert.equal(budget.sourceInventoryDigestComputations,4);verifyApiSourcekitRoots(kit,roots,0);
    const index=JSON.parse(fs.readFileSync(kit.index,'utf8'));assert.equal(index.originMappings.flatMap((row:any)=>row.origins).length,5);assert(index.originMappings.every((row:any)=>row.origins.every((origin:any)=>!('directory' in origin))));
    const originalIndex=fs.readFileSync(kit.index);
    const unsafe=JSON.parse(originalIndex.toString());unsafe.originMappings[0].origins[0].path='../escape';fs.writeFileSync(kit.index,JSON.stringify(unsafe));assert.throws(()=>verifyApiSourcekits([kit],0),/source origin/);fs.writeFileSync(kit.index,originalIndex);
    const forgedOwner=JSON.parse(originalIndex.toString());forgedOwner.originMappings[0].origins[0].owners[0].sha256='0'.repeat(64);fs.writeFileSync(kit.index,JSON.stringify(forgedOwner));assert.throws(()=>verifyApiSourcekits([kit],0),/provenance hash mismatch/);fs.writeFileSync(kit.index,originalIndex);
    const duplicateIndex=JSON.parse(originalIndex.toString());duplicateIndex.originMappings[0].origins.push(duplicateIndex.originMappings[0].origins[0]);fs.writeFileSync(kit.index,JSON.stringify(duplicateIndex));assert.throws(()=>verifyApiSourcekits([kit],0),/duplicate source origin/);fs.writeFileSync(kit.index,originalIndex);
    fs.writeFileSync(second.directory+'/source.js','drift');assert.throws(()=>verifyApiSourcekitRoots(kit,roots,0),/origin|inventory|mapping/);assert.throws(()=>writeApiSourcekit(base+'/rejected',roots,0),/origin|inventory|mapping/);assert.equal(fs.existsSync(base+'/rejected'),false);fs.writeFileSync(second.directory+'/source.js','original');
    fs.chmodSync(second.directory+'/source.js',0o755);assert.throws(()=>verifyApiSourcekitRoots(kit,roots,0),/origin|inventory|mapping/);fs.chmodSync(second.directory+'/source.js',0o644);
    fs.writeFileSync(second.directory+'/package.json',JSON.stringify({name:'same-package',version:'9.0.0'}));assert.throws(()=>verifyApiSourcekitRoots(kit,roots,0),/origin|inventory|mapping/);fs.writeFileSync(second.directory+'/package.json',JSON.stringify({name:'same-package',version:'1.0.0'}));
    const changed=structuredClone(roots) as ApiSourceRoot[];changed.find(root=>root.origins?.length===2)!.origins![1].inventorySHA256='0'.repeat(64);assert.throws(()=>verifyApiSourcekitRoots(kit,changed,0),/mapping/);
    const duplicate=structuredClone(roots) as ApiSourceRoot[];const aliases=duplicate.find(root=>root.origins?.length===2)!.origins!;aliases.push(aliases[0]);assert.throws(()=>verifyApiSourcekitRoots(kit,duplicate,0),/Duplicate physical/);
    const missing=structuredClone(roots) as ApiSourceRoot[];delete missing.find(root=>root.origins)!.origins;assert.throws(()=>verifyApiSourcekitRoots(kit,missing,0),/mapping missing/);
    const omitted=structuredClone(roots) as ApiSourceRoot[];omitted.find(root=>root.origins?.length===2)!.origins!.pop();assert.throws(()=>verifyApiSourcekitRoots(kit,omitted,0),/inventory drift/);
    const owner=structuredClone(roots) as ApiSourceRoot[];owner.find(root=>root.origins?.length===2)!.origins![1].owners[0].from='forged/owner.json';assert.throws(()=>verifyApiSourcekitRoots(kit,owner,0),/inventory drift/);assert.throws(()=>writeApiSourcekit(base+'/forged-owner',owner,0),/provenance not archived/);assert.equal(fs.existsSync(base+'/forged-owner'),false);
    verifyApiSourcekitRoots(kit,roots,0);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
}, API_BUILD_INTEGRATION_TIMEOUT_MS);

test('many aliases compute their shared inventory digest once while rejecting alias drift', () => {
  const parent=path.resolve('.test-data/api-source-origin-dedup');fs.mkdirSync(parent,{recursive:true});
  const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'many-')));
  try {
    const files:string[]=[];const physical:ApiSourceRoot[]=[];
    for(let n=0;n<24;n++) {
      const relative='owner-'+n+'.json';const body=JSON.stringify({dependencies:{shared:'1.0.0'}});
      fs.writeFileSync(path.join(base,relative),body);files.push(relative);
      const directory=path.join(base,'alias-'+n);fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'shared',version:'1.0.0'}));
      fs.writeFileSync(path.join(directory,'source.js'),'original');
      physical.push({directory,prefix:'physical/'+n,owners:[{kind:'declaration',from:relative,sha256:createHash('sha256').update(body).digest('hex')}]});
    }
    const roots=deduplicateApiSourceRoots([{directory:base,prefix:'canonical',files},...physical]);
    assert.equal(roots.find(root=>root.origins)?.origins?.length,24);
    const {kit,budget}=writeApiSourcekit(path.join(base,'archive'),roots,0);
    assert.equal(budget.sourceInventoryDigestComputations,1);
    const bytes=fs.readFileSync(kit.index);const index=JSON.parse(bytes.toString());
    index.originMappings[0].origins[23].manifest.version='2.0.0';fs.writeFileSync(kit.index,JSON.stringify(index));
    assert.throws(()=>verifyApiSourcekits([kit],0),/inventory identity mismatch/);
    fs.writeFileSync(kit.index,bytes);
    fs.writeFileSync(path.join(physical[23].directory,'source.js'),'drift');
    assert.throws(()=>verifyApiSourcekitRoots(kit,roots,0),/origin|inventory|mapping/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
}, API_BUILD_INTEGRATION_TIMEOUT_MS);
