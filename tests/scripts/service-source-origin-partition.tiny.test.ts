/**
 * F1 — origin partition over GENUINE runtime archive bytes.
 *
 * The archives here are built by a real Python tar writer and parsed by the real
 * production parser `inspectCandidateServiceRuntimeArchive`. Each declared root
 * (`/app` and `/opt/xpod/qlever`) genuinely contributes its mandatory archive
 * root DIRECTORY member plus a regular file. The partition mechanic under test
 * (`inspectCandidateServiceSourceOrigins`) is exactly the one the SOURCE factory
 * calls, so this exercises the F1 defect class with no fabricated summary.
 */
import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inspectCandidateServiceRuntimeArchive} from '../../scripts/lib/independent-admission/candidate-service-runtime-artifact';
import {inspectCandidateServiceSourceOrigins} from '../../scripts/lib/independent-admission/candidate-service-source-qualification';

const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
/** Mirrors the production parent budget contract; charges are asserted below. */
const budget={check(){},remainingMs:()=>600000,reserveBytes(){},chargeReadBytes(){},
  remainingReadBytes:()=>1e9,remainingOriginalBytes:()=>1e9,
  reserveOriginalMaximum(){return Object.freeze({});},settleOriginalReservation(){}} as any;
/** Absolute member path exactly as the production view computes it. */
const absoluteOf=(members:readonly any[])=>members.map((row:any)=>({...row,
  path:row.absolutePath}));
const IMAGE='ghcr.io/undefinedsco/xpod@sha256:'+'a'.repeat(64);
const CONFIG='sha256:'+'b'.repeat(64);
const CID='c'.repeat(64);
const PY=String.raw`
import hashlib, io, json, sys, tarfile
out=sys.argv[1]; root=sys.argv[2]; archive=sys.argv[3]; label=sys.argv[4]
files={'payload':b'actual runtime payload '+label.encode()}
with tarfile.open(out,'w',format=tarfile.PAX_FORMAT) as tf:
    info=tarfile.TarInfo(archive+'/'); info.mode=0o755; info.type=tarfile.DIRTYPE; info.size=0
    tf.addfile(info,None)
    for name,body in files.items():
        row=tarfile.TarInfo(archive+'/'+name); row.mode=0o644; row.type=tarfile.REGTYPE; row.size=len(body)
        tf.addfile(row,io.BytesIO(body))
raw=open(out,'rb').read(); rows=[]; at=0
while at+512<=len(raw):
    header=raw[at:at+512]
    if header==bytes(512): break
    name=header[:100].split(b'\0')[0].decode(); kind=header[156:157].decode('latin1') or '0'
    size=int(header[124:136].split(b'\0')[0].strip() or b'0',8); mode=int(header[100:108].split(b'\0')[0].strip() or b'0',8)
    rel='' if name.rstrip('/')==archive else name.rstrip('/')[len(archive)+1:]
    if kind in ('0','\0','7'):
        rows.append(dict(path=rel,type='file',mode=mode,bytes=size,sha256=hashlib.sha256(raw[at+512:at+512+size]).hexdigest(),offset=at+512))
    elif kind=='5':
        rows.append(dict(path=rel,type='directory',mode=mode,bytes=0))
    else: raise AssertionError(kind)
    at+=512+(size+((512-size%512)%512) if kind in ('0','\0','7') else 0)
print(json.dumps({'members':rows,'archiveSha':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'content':sum(r['bytes'] for r in rows if r['type']=='file')}))
`;

/** Parse one REAL archive for one declared root through the production parser. */
function realRoot(rootDir:string,root:'/app'|'/opt/xpod/qlever',label:string){
  const archivePath=path.join(rootDir,label+'.tar');
  const archiveRoot=root==='/app'?'app':'qlever';
  const run=spawnSync('/usr/bin/python3',['-c',PY,archivePath,root,archiveRoot,label],{encoding:'utf8'});
  if(run.status!==0)throw Error('python tar failed: '+run.stderr);
  const built=JSON.parse(run.stdout) as {members:any[];archiveSha:string;bytes:number;content:number};
  const raw=Buffer.from(require('node:fs').readFileSync(archivePath));
  const index={schemaVersion:1,kind:'actual-service-image-runtime-members-v1',targetRoot:root,
    archiveRoot:root==='/app'?'app':'qlever',imageReferenceByDigest:IMAGE,configDigest:CONFIG,containerId:CID,
    archive:{path:'stages/out/stdout.raw',bytes:raw.length,sha256:built.archiveSha},
    sourceCoverageInferred:false,wholeServiceSourceVerified:false,evidencePayloadPaths:[],
    members:built.members,memberContentBytes:built.content};
  const parsed=inspectCandidateServiceRuntimeArchive({capture:Buffer.from(JSON.stringify(index)),
    scope:{root,role:(root==='/app'?'copy-runtime-app':'copy-runtime-sdk') as any},
    readRange:(offset:number,length:number)=>raw.subarray(offset,offset+length)});
  return {parsed,raw};
}

test('both declared roots genuinely contribute a directory root member',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'origin-roots-'));
  try{
    const app=realRoot(dir,'/app','app');
    const sdk=realRoot(dir,'/opt/xpod/qlever','sdk');
    expect(app.parsed.members[0]).toMatchObject({path:'',type:'directory',bytes:0});
    expect(sdk.parsed.members[0]).toMatchObject({path:'',type:'directory',bytes:0});
    // The genuine absolute paths are exactly the two roots F1 must handle.
    expect(absoluteOf(app.parsed.members).map((row:any)=>row.path)).toContain('/app');
    expect(absoluteOf(sdk.parsed.members).map((row:any)=>row.path)).toContain('/opt/xpod/qlever');
  }finally{rmSync(dir,{recursive:true,force:true});}
},60000);

test('partition covers every regular file and never invents a grant for a directory root',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'origin-partition-'));
  try{
    const app=realRoot(dir,'/app','app'),sdk=realRoot(dir,'/opt/xpod/qlever','sdk');
    // One shared runtime view: both roots flattened, exactly like production.
    const members=[...absoluteOf(app.parsed.members),...absoluteOf(sdk.parsed.members)];
    const appPayload=members.find(row=>row.path==='/app/payload')!;
    const sdkPayload=members.find(row=>row.path==='/opt/xpod/qlever/payload')!;
    const runtime={
      members,
      readMemberRange(name:string,offset:number,length:number){
        const root=name.startsWith('/app')?'/app':'/opt/xpod/qlever';
        const raw=(root==='/app'?app:sdk).raw;
        const row=absoluteOf((root==='/app'?app:sdk).parsed.members).find((item:any)=>item.path===name);
        return raw.subarray(Number(row.dataOffset)+offset,Number(row.dataOffset)+offset+length);
      },
      assertCurrent(){},
    };
    // Real material reader for the app payload so it becomes exact-source.
    const materials={
      sourceSha:'a'.repeat(40),
      outputs:[{path:'payload',bytes:appPayload.bytes,sha256:appPayload.sha256,mode:0o644}],
      transpiledOutputs:[],dependencyRows:[],trackedSourcePaths:['package.json'],
      readDependencyOriginal:()=>Buffer.alloc(0),readDependencyOriginalRange:()=>Buffer.alloc(0),
      dependencyOriginalIdentity:()=>({bytes:0,sha256:sha(Buffer.alloc(0))}),
      assertCurrent(){},
    };
    const held=inspectCandidateServiceSourceOrigins({
      sourceSha:'a'.repeat(40),sdkSourceSha:'d'.repeat(40),materials,budget,
      runtime,
      nativeOrigins:[{path:'/opt/xpod/qlever/payload',kind:'native-runtime',runtimePath:'payload',original:{}}],
      generated:[]});
    // Structural directory roots are retained in the typed inventory...
    expect(held.members.filter(row=>row.type==='directory').map(row=>row.path).sort())
      .toEqual(['/app','/opt/xpod/qlever']);
    // ...but receive NO source/native grant.
    expect(held.map.has('/app')).toBe(false);
    expect(held.map.has('/opt/xpod/qlever')).toBe(false);
    // Every regular file is covered exactly once.
    const files=held.members.filter(row=>row.type==='file').map(row=>row.path).sort();
    expect([...held.map.keys()].sort()).toEqual(files);
    expect(held.map.get('/app/payload')?.kind).toBe('exact-source');
    expect(held.map.get('/opt/xpod/qlever/payload')?.kind).toBe('native-runtime');
  }finally{rmSync(dir,{recursive:true,force:true});}
},60000);

test('an uncovered regular file or an unknown root is refused, never ignored',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'origin-refuse-'));
  try{
    const app=realRoot(dir,'/app','app');
    const members=[{path:'/somewhere/else',type:'file',bytes:1,sha256:'e'.repeat(64),dataOffset:0},
      ...absoluteOf(app.parsed.members)];
    const runtime={members,readMemberRange:(name:string,offset:number,length:number)=>{
      const row=members.find((item:any)=>item.path===name)!;
      return app.raw.subarray(Number(row.dataOffset)+offset,Number(row.dataOffset)+offset+length);
    },assertCurrent(){}};
    const materials={sourceSha:'a'.repeat(40),outputs:[],transpiledOutputs:[],dependencyRows:[],trackedSourcePaths:[],
      readDependencyOriginal:()=>Buffer.alloc(0),readDependencyOriginalRange:()=>Buffer.alloc(0),
      dependencyOriginalIdentity:()=>({bytes:0,sha256:sha(Buffer.alloc(0))}),assertCurrent(){}};
    expect(()=>inspectCandidateServiceSourceOrigins({sourceSha:'a'.repeat(40),sdkSourceSha:'d'.repeat(40),materials,budget,runtime,nativeOrigins:[],generated:[]}))
      .toThrow('outside both declared roots');
    // A real app file with no material and no installed projection is refused.
    const real=absoluteOf(app.parsed.members);
    const appOnly={members:real,readMemberRange:(name:string,offset:number,length:number)=>{
      const row=real.find((item:any)=>item.path===name)!;return app.raw.subarray(Number(row.dataOffset)+offset,Number(row.dataOffset)+offset+length);
    },assertCurrent(){}};
    expect(()=>inspectCandidateServiceSourceOrigins({sourceSha:'a'.repeat(40),sdkSourceSha:'d'.repeat(40),materials,budget,runtime:appOnly,nativeOrigins:[],generated:[]}))
      .toThrow('without material source or installed projection');
  }finally{rmSync(dir,{recursive:true,force:true});}
},60000);

test('a regular file whose live bytes differ from the inventory is refused',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'origin-bytes-'));
  try{
    const app=realRoot(dir,'/app','app');
    const real=absoluteOf(app.parsed.members);
    const materials={sourceSha:'a'.repeat(40),outputs:[],transpiledOutputs:[],dependencyRows:[],trackedSourcePaths:[],
      readDependencyOriginal:()=>Buffer.alloc(0),readDependencyOriginalRange:()=>Buffer.alloc(0),
      dependencyOriginalIdentity:()=>({bytes:0,sha256:sha(Buffer.alloc(0))}),assertCurrent(){}};
    // V4: payloads are NOT re-read; the issued inventory digest is the proof.
    // A declaration that disagrees with that issued inventory is still refused.
    const runtime={members:real,readMemberRange:()=>{throw Error('partition must not re-read payloads');},
      assertCurrent(){}};
    const tamperedMaterials={sourceSha:'a'.repeat(40),
      outputs:[{path:'payload',bytes:1,sha256:'f'.repeat(64),mode:0o644}],
      transpiledOutputs:[],dependencyRows:[],trackedSourcePaths:['payload'],
      readDependencyOriginal:()=>Buffer.alloc(0),readDependencyOriginalRange:()=>Buffer.alloc(0),
      dependencyOriginalIdentity:()=>({bytes:0,sha256:sha(Buffer.alloc(0))}),assertCurrent(){}};
    expect(()=>inspectCandidateServiceSourceOrigins({sourceSha:'a'.repeat(40),sdkSourceSha:'d'.repeat(40),
      materials:tamperedMaterials,budget,runtime,nativeOrigins:[],generated:[]}))
      .toThrow('runtime file differs from its materialized source bytes');
  }finally{rmSync(dir,{recursive:true,force:true});}
},60000);

test('an SDK regular file without a native origin is refused (no silent skip)',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'origin-sdk-'));
  try{
    const sdk=realRoot(dir,'/opt/xpod/qlever','sdk');
    const members=absoluteOf(sdk.parsed.members);
    const runtime={members,readMemberRange:(name:string,offset:number,length:number)=>{
      const row:any=members.find((item:any)=>item.path===name)!;
      return sdk.raw.subarray(Number(row.dataOffset)+offset,Number(row.dataOffset)+offset+length);
    },assertCurrent(){}};
    const materials={sourceSha:'a'.repeat(40),outputs:[],transpiledOutputs:[],dependencyRows:[],trackedSourcePaths:[],
      readDependencyOriginal:()=>Buffer.alloc(0),readDependencyOriginalRange:()=>Buffer.alloc(0),
      dependencyOriginalIdentity:()=>({bytes:0,sha256:sha(Buffer.alloc(0))}),assertCurrent(){}};
    expect(()=>inspectCandidateServiceSourceOrigins({sourceSha:'a'.repeat(40),sdkSourceSha:'d'.repeat(40),
      materials,budget,runtime,nativeOrigins:[],generated:[]})).toThrow('without native origin');
  }finally{rmSync(dir,{recursive:true,force:true});}
},60000);
