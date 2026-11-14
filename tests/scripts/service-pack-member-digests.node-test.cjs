'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const {execFileSync}=require('node:child_process');
const {inspectTarballStream}=require('../../scripts/workspace-package-payload.cjs');
const limits={expandedBytes:1024*1024,members:100,manifestBytes:128*1024};
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
test('explicit digest mode preserves actual member bytes/modes and default result shape',async()=>{
 fs.mkdirSync('.test-data',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-data/service-pack-member-digests-'));
 try{
  const pkg=path.join(root,'package');fs.mkdirSync(pkg);fs.mkdirSync(path.join(pkg,'empty-directory'));
  const manifest=Buffer.from('{"name":"actual","version":"1.0.0"}\n'),payload=Buffer.alloc(65537,91);
  fs.writeFileSync(path.join(pkg,'package.json'),manifest);fs.writeFileSync(path.join(pkg,'executable'),payload,{mode:0o755});fs.writeFileSync(path.join(pkg,'empty'),Buffer.alloc(0));
  const tar=path.join(root,'actual.tgz');execFileSync('tar',['--format=ustar','-czf',tar,'-C',root,'package']);const raw=fs.readFileSync(tar);
  const parse=extra=>inspectTarballStream(Readable.from((function*(){for(let at=0;at<raw.length;at+=17)yield raw.subarray(at,at+17);})()),{...limits,...extra});
  const plain=await parse({}),actual=await parse({memberDigests:true,memberMetadataBytes:4096});assert.equal(Object.hasOwn(plain,'memberDigests'),false);
  const {memberDigests,...rest}=actual;assert.deepEqual(rest,plain);assert.equal(memberDigests.length,actual.members);
  const byPath=new Map(memberDigests.map(row=>[row.path,row]));
  assert.deepEqual(byPath.get('package/executable'),{path:'package/executable',type:'file',mode:0o755,bytes:payload.length,sha256:sha(payload)});
  assert.equal(byPath.get('package/empty').sha256,sha(Buffer.alloc(0)));assert.equal(byPath.get('package/package.json').sha256,sha(manifest));
  const dir=byPath.get('package/empty-directory/');assert.equal(dir.type,'directory');assert.equal(dir.bytes,0);assert.equal(Object.hasOwn(dir,'sha256'),false);
  const metadataBytes=Buffer.byteLength(JSON.stringify(memberDigests));await parse({memberDigests:true,memberMetadataBytes:metadataBytes});
  await assert.rejects(parse({memberDigests:true,memberMetadataBytes:metadataBytes-1}),/member metadata budget/);
  await assert.rejects(parse({memberDigests:false}),/Explicit member digest/);await assert.rejects(parse({memberMetadataBytes:4096}),/metadata budget/);
  fs.symlinkSync('empty',path.join(pkg,'link'));execFileSync('tar',['--format=ustar','-czf',tar,'-C',root,'package']);
  await assert.rejects(inspectTarballStream(Readable.from([fs.readFileSync(tar)]),{...limits,memberDigests:true,memberMetadataBytes:4096}),/Unsupported tar entry/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
