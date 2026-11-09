const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {emitClientPublication}=require('./client-publication.cjs');
const {inspectTarballBuffer,sha512Integrity}=require('../../../scripts/workspace-package-payload.cjs');
const {runPublicationCommand}=require('../../../scripts/lib/afs-publication-command.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function stageAndPackClient({packageRoot,repoRoot,output,assertCurrent,binding=null,env=process.env}, execute=runPublicationCommand){
  const stage=path.join(output,'package'),archive=path.join(output,'xpod-afs.tgz');
  if(fs.existsSync(archive))throw new Error('Fresh normal archive required');
  const result=emitClientPublication({packageRoot,repoRoot,destination:stage,assertCurrent});
  assertCurrent();
  const command=await execute('bun',['pm','pack','--ignore-scripts','--filename',archive],{cwd:stage,env,evidence:output,label:'normal-pack'});
  assertCurrent();
  const bytes=fs.readFileSync(archive),inspected=inspectTarballBuffer(bytes);
  if(inspected.manifest.name!==result.manifest.name||inspected.manifest.version!==result.manifest.version||JSON.stringify(inspected.manifest)!==JSON.stringify(result.manifest))throw new Error('Normal archive manifest mismatch');
  const members=inspected.entries.filter(entry=>entry.type==='file');
  if(members.length!==result.inventory.length||new Set(members.map(x=>x.path)).size!==members.length||inspected.entries.some(x=>x.type!=='file'&&x.type!=='directory'))throw new Error('Normal archive member mismatch');
  const expected=new Map(result.inventory.map(row=>['package/'+row.path,row]));
  for(const member of members){const row=expected.get(member.path);if(!row||member.content.length!==row.bytes||hash(member.content)!==row.sha256||member.mode!==row.mode)throw new Error('Normal archive payload mismatch');}
  const receipt={kind:'afs-js-normal-publication',name:result.manifest.name,version:result.manifest.version,archive:{path:archive,bytes:bytes.length,sha256:hash(bytes),integrity:sha512Integrity(bytes)},stage:result,producerBinding:binding,command,consumerQualified:false,sourceQualified:false,releaseQualified:false};
  assertCurrent();fs.writeFileSync(path.join(output,'publication.original.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
module.exports={stageAndPackClient};
