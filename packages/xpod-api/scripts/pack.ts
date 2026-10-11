import {verifyPhysicalNativeMaterials} from '../../../scripts/lib/physical-module-native';
import {verifyPhysicalNotices} from '../../../scripts/lib/physical-module-notices';
import {packPhysicalModule} from '../../../scripts/lib/physical-module-archive';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const stage=path.resolve(process.argv[2]??'');const output=process.argv[3];if(!process.argv[2]||!output||existsSync(output))throw new Error('Explicit fresh stage/archive paths required');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const git=(args:string[])=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status!==0)throw new Error('Git source authority unavailable');return r.stdout.trim();};
function scan(root:string, relative=''):string[]{const found:string[]=[];for(const name of readdirSync(path.join(root,relative))){const f=relative?relative+'/'+name:name;const st=lstatSync(path.join(root,f));if(st.isSymbolicLink())throw new Error('Product symlink rejected');if(st.isDirectory())found.push(...scan(root,f));else if(st.isFile())found.push(f);else throw new Error('Product nonregular member rejected');}return found.sort();}
if(!readFileSync(path.join(stage,'NOTICE')).length)throw new Error('Original third-party NOTICE inventory required');
const notice=JSON.parse(readFileSync(path.join(stage,'provenance/terms/index.json'),'utf8'));if(notice.schemaVersion!==1||notice.status!=='original-material-collection'||notice.legalClearance!==false)throw new Error('Original notice material inventory required');
const publicationPath=path.join(stage,'provenance/publication.json');
const publication=existsSync(publicationPath)?JSON.parse(readFileSync(publicationPath,'utf8')):{mode:'preview'};
if(publication.mode==='release'&&!process.argv[4])throw new Error('Formal API pack requires explicit external native materials root');
const materialsRoot=process.argv[4]?path.resolve(process.argv[4]):undefined;
if(publication.mode!=='release'&&materialsRoot)throw new Error('External materials root belongs to explicit release mode');
if(publication.mode!=='release'){
const nativeRoot=path.join(stage,'provenance/native/inngest');
const native=JSON.parse(readFileSync(path.join(nativeRoot,'index.json'),'utf8'));
for(const [file,expected] of [['release.tar.gz',native.officialArchiveSHA256],['source.tar.gz',native.sourceArchiveSHA256]] as const)if(!/^[a-f0-9]{64}$/u.test(expected)||hash(readFileSync(path.join(nativeRoot,file)))!==expected)throw new Error('Native original material drift');
if(native.binarySHA256!==hash(readFileSync(path.join(stage,'node_modules/inngest-cli/bin/inngest')))||native.licenseSHA256!==hash(readFileSync(path.join(stage,'node_modules/inngest-cli/bin/LICENSE.md'))))throw new Error('Native executable/original terms drift');
}
for(const f of ['package.json','bun.lock','LICENSE','packages/xpod-cli/src/module-catalog.ts','scripts/lib/physical-module-stage.ts','scripts/lib/physical-module-archive.ts','scripts/lib/physical-module-notices.ts','scripts/lib/physical-module-bins.ts','scripts/lib/physical-module-native.ts','packages/xpod-cli/src/source-materials.ts','packages/xpod-cli/src/manifest.ts','scripts/agentfs-native-ci/supervise.py','docs/testing/physical-module-native-materials.md',...scan(path.join(repo,'packages/xpod-api')).filter(f=>!f.startsWith('dist/')).map(f=>'packages/xpod-api/'+f)]){
 const to=path.join(stage,'source',f);mkdirSync(path.dirname(to),{recursive:true});copyFileSync(path.join(repo,f),to);
}
const sources=scan(path.join(stage,'source')).map(f=>{const bytes=readFileSync(path.join(stage,'source',f));const original=readFileSync(path.join(repo,f));if(!bytes.equals(original))throw new Error('Canonical source drift');return {path:f,bytes:bytes.length,sha256:hash(bytes),tracked:git(['ls-files','--',f])===f};});
const authority={sourceCommit:git(['rev-parse','HEAD']),dirty:git(['status','--porcelain']).length>0,snapshotSHA256:hash(Buffer.from(JSON.stringify(sources))),scope:'actual canonical service source closure and original producer/toolchain declarations'};
writeFileSync(path.join(stage,'provenance','source-inventory.json'),JSON.stringify({schemaVersion:1,sourceAuthority:authority,files:sources},null,2)+'\n');
function verifyReleaseMaterials():void {
 if(authority.dirty||publication.sourceCommit!==authority.sourceCommit)throw new Error('Formal API source material is not bound to an actual clean Git tree');
 verifyPhysicalNotices(stage,true);
 if(!materialsRoot)throw new Error('Formal API pack requires explicit external native materials root');
 verifyPhysicalNativeMaterials(stage,{materialsRoot});
}
if(publication.mode==='release')verifyReleaseMaterials();
const releaseStatus=publication.mode==='release'
 ? {schemaVersion:1,status:'candidate',declaredSourceClean:true,sourceAuthority:authority,materials:{source:'verified',native:'internally-bound',notices:'originals-verified'},externalGateStatus:'pending'}
 : {schemaVersion:1,publishReady:false,nativeAuthority:'official-release-byte-bound',noticeAudit:'pending',sourceAuthority:authority,limitations:['Controlled local platform archive only','Complete third-party obligations audit pending']};
writeFileSync(path.join(stage,'provenance','release-status.json'),JSON.stringify(releaseStatus,null,2)+'\n');
const packed=packPhysicalModule(stage,output,{moduleId:'api',entry:'entry.mjs',sourceRoot:repo,verifyReleaseMaterials});
console.log(JSON.stringify({...packed,...(publication.mode==='release'?{status:'candidate',externalGateStatus:'pending'}:{publishReady:false})}));
