const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {normalizeWorkspaceDependencies}=require('./workspace-package-pack.cjs');
const {PACKAGES}=require('./workspace-package-consumer.cjs');
const {inspectTarballBuffer,sha512Integrity}=require('./workspace-package-payload.cjs');
const {runPublicationCommand}=require('./lib/afs-publication-command.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const ref=(base,file)=>{const bytes=fs.readFileSync(file);return{path:path.relative(base,file).split(path.sep).join('/'),bytes:bytes.length,sha256:hash(bytes)};};
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
function snapshotWorkspace(root, rawDirectory = null, suffix = null){
 const gitCommands=[];
 const git=(label,args)=>{
  const result=spawnSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});
  if(rawDirectory){
   const raw=['stdout','stderr'].map(kind=>{
    const file=path.join(rawDirectory,'source-'+suffix+'-'+label+'.'+kind+'.raw.log');
    fs.writeFileSync(file,result[kind]||Buffer.alloc(0),{flag:'wx'});return ref(rawDirectory,file);
   });
   gitCommands.push({command:'git',args,cwd:root,actualReturnCode:result.status,signal:result.signal,waitStatus:result.status!==null||result.signal?'known':'unknown',rawClosedBeforeHash:true,raw});
  }
  if(result.error||result.status!==0||result.signal)throw new Error('Source Git command failed: '+label);
  return result.stdout;
 };
 const sourceSha=git('head',['rev-parse','HEAD']).toString().trim();
 const status=git('status',['status','--porcelain','--untracked-files=all']);
 const rows=git('tracked-index',['ls-files','--stage','-z']).toString().split('\0').filter(Boolean);const files=[];
 for(const row of rows){
  const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);if(!match)throw new Error('Tracked input must be a regular nonconflicted file');
  const [,mode,blob,name]=match;
  if(path.isAbsolute(name)||name.split('/').some(x=>x==='..'||x==='.'||!x))throw new Error('Unsafe tracked input');
  const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Tracked input is not regular');
  const bytes=fs.readFileSync(file),actualBlob=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  files.push({path:name,mode,bytes:bytes.length,sha256:hash(bytes),gitBlob:blob,matchesGit:actualBlob===blob});
 }
 const inputs={sourceSha,clean:status.length===0,statusSHA256:hash(status),files:files.sort((a,b)=>a.path.localeCompare(b.path))};
 return{...inputs,inputSHA256:hash(Buffer.from(JSON.stringify(inputs))),gitCommands};
}
function validateOriginalArchives(root,output,evidence){
 const names=PACKAGES.map(name=>JSON.parse(fs.readFileSync(path.join(root,'packages',name,'package.json'))));
 if(!Array.isArray(evidence.packages)||evidence.packages.length!==names.length)throw new Error('Incomplete normal archive evidence');
 const seen=new Set();const archives=[];
 for(const expected of names){
  const rows=evidence.packages.filter(row=>row.packageName===expected.name);if(rows.length!==1)throw new Error('Duplicate or missing normal archive identity');
  const row=rows[0];if(typeof row.name!=='string'||row.name!==path.basename(row.name)||/[\\\x00-\x1f]/.test(row.name)||seen.has(row.name))throw new Error('Unsafe normal archive name');seen.add(row.name);
  const file=path.join(output,'archives',row.name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Normal archive must be regular');
  const bytes=fs.readFileSync(file),manifest=inspectTarballBuffer(bytes).manifest;
  if(bytes.length!==row.size||hash(bytes)!==row.sha256||sha512Integrity(bytes)!==row.integrity||row.version!==expected.version||manifest.name!==expected.name||manifest.version!==expected.version)throw new Error('Normal archive byte/identity mismatch');
  const normalized=normalizeWorkspaceDependencies(root,expected);
  for(const field of ['dependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','devDependencies'])if(JSON.stringify(manifest[field])!==JSON.stringify(normalized[field]))throw new Error('Normal archive dependency declarations differ');
  archives.push({...ref(output,file),packageName:manifest.name,version:manifest.version,integrity:sha512Integrity(bytes)});
 }
 return archives;
}
function observedComposite(phase){
 return{...phase,actualReturnCode:'actualReturnCode' in phase?phase.actualReturnCode:phase.code,waitStatus:'waitStatus' in phase?phase.waitStatus:(phase.actualWait===true?'known':'unknown')};
}
async function collectWorkspaceNormalRun({root,sourceSha,output},execute=runPublicationCommand){
 root=fs.realpathSync(root);output=path.resolve(output);
 if(!/^[a-f0-9]{40}$/.test(sourceSha)||fs.realpathSync(path.dirname(output))!==path.dirname(output)||fs.existsSync(output))throw new Error('Exact source and fresh canonical output required');
 fs.mkdirSync(output,{recursive:false});let phase=null,archives=[],before=null,after=null,primary=null,tools=[];
 const original=path.join(output,'workspace-consumer-evidence.original.json');
 try{
  before=snapshotWorkspace(root,output,'before');write(path.join(output,'source-inputs-before.original.json'),before);
  if(before.sourceSha!==sourceSha||!before.clean||before.files.some(row=>!row.matchesGit))throw new Error('Clean canonical tracked source required');
  tools=['scripts/workspace-package-consumer.cjs','scripts/workspace-package-pack.cjs','scripts/workspace-package-payload.cjs','scripts/workspace-package-typecheck.cjs'].map(file=>{
   if(!before.files.some(row=>row.path===file))throw new Error('Normal tool must be a tracked source input');return{...ref(root,path.join(root,file))};
  });
  phase=await execute(process.execPath,[path.join(root,'scripts/workspace-package-consumer.cjs'),'--local','--source-sha',sourceSha,'--archive-dir',path.join(output,'archives'),'--evidence',original],{cwd:root,env:process.env,evidence:output,label:'normal-pack-and-consumer',timeoutMs:600000});
  phase=observedComposite(phase);
  // Treat the phase as one composite execution; do not invent individual child phases.
  if(phase.code!==0||phase.actualReturnCode!==0||phase.signal!==null||phase.spawnError||phase.cwd!==root
    ||phase.actualWait!==true||phase.waitStatus!=='known'||phase.actualClose!==true||phase.groupAbsent!==true
    ||phase.rawComplete!==true||phase.rawClosed!==true||phase.rawClosedBeforeHash!==true
    ||!Array.isArray(phase.pipeEOF)||phase.pipeEOF.length!==2||!phase.pipeEOF.every(value=>value===true))throw new Error('Normal composite phase not closed successfully');
  if(!Array.isArray(phase.raw)||phase.raw.length!==2)throw new Error('Closed raw evidence required');
  for(const [index,raw] of phase.raw.entries()){if(raw?.path!==`normal-pack-and-consumer.${['stdout','stderr'][index]}.raw.log`)throw new Error('Exact ordered stdout/stderr originals required');if(raw.status!==undefined&&raw.status!=='complete')throw new Error('Incomplete or truncated raw evidence');if(raw.path!==path.basename(raw.path))throw new Error('Unsafe phase raw reference');const actual=ref(output,path.join(output,raw.path));if(actual.bytes!==raw.bytes||actual.sha256!==raw.sha256)throw new Error('Phase raw evidence changed');}
  const evidence=JSON.parse(fs.readFileSync(original));if(evidence.kind!=='workspace-consumer-acceptance'||evidence.sourceSha!==sourceSha)throw new Error('Normal child evidence identity mismatch');
  archives=validateOriginalArchives(root,output,evidence);
 }catch(error){primary=error;if(error.outcome)phase=observedComposite(error.outcome);}
 try{after=snapshotWorkspace(root,output,'after');write(path.join(output,'source-inputs-after.original.json'),after);}
 catch(error){primary??=error;}
 if(!before||!after||before.sourceSha!==sourceSha||after.sourceSha!==sourceSha||!before.clean||!after.clean||before.inputSHA256!==after.inputSHA256)primary??=new Error('Source inputs changed during normal run');
 const record={kind:'workspace-consumer-acceptance',schemaVersion:1,sourceSha,ok:!primary,
  execution:{root,collector:{actualPath:__filename,...ref(root,__filename)},commandRunner:{actualPath:require.resolve('./lib/afs-publication-command.cjs'),...ref(root,require.resolve('./lib/afs-publication-command.cjs'))},scope:'one existing consumeLocal normal pack + consumer command; no invented child phase or prior build claim',phase,tools,sourceBefore:fs.existsSync(path.join(output,'source-inputs-before.original.json'))?ref(output,path.join(output,'source-inputs-before.original.json')):null,sourceAfter:fs.existsSync(path.join(output,'source-inputs-after.original.json'))?ref(output,path.join(output,'source-inputs-after.original.json')):null},
  workspaceEvidence:fs.existsSync(original)?ref(output,original):null,archives,
  buildAuthority:false,sourceAdmission:false,registryAdmission:false,releaseQualified:false,failure:primary?String(primary.message):null};
 write(path.join(output,'normal-run.original.json'),record);
 if(primary)throw Object.assign(primary,{receipt:path.join(output,'normal-run.original.json')});return record;
}
module.exports={snapshotWorkspace,validateOriginalArchives,collectWorkspaceNormalRun};
if(require.main===module){
 (async()=>{if(process.argv.length!==5)throw new Error('Usage: collector ROOT SOURCE_SHA OUTPUT');await collectWorkspaceNormalRun({root:process.argv[2],sourceSha:process.argv[3],output:process.argv[4]});})().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
}
