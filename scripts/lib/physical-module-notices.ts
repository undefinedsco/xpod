import {verifyNoticeSourceAttestation,reviewedNoticeVerifierPlan,noticeVerifierReceiptOriginals,verifyNoticeVerifierHttpOriginals} from './notice-source-attestation';
import type {BigIntStats} from 'node:fs';
import {openSync,closeSync,readSync,fstatSync,constants,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyMitGrantText,verifyIscGrantText,explicitLicenseConflicts} from './independent-admission/legal-admission';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {inspectRegistryLegalArchive,registryLegalLockEntries,REGISTRY_LEGAL_ORIGINAL_LIMITS} from './independent-admission/legal-registry-originals';
const {parseTar}=createRequire(import.meta.url)('../workspace-package-payload.cjs');
const SOURCE_ARCHIVE_PACKED_BYTES=16*1024**2;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function safeFile(root:string,relative:string):string {
 if(!relative||path.isAbsolute(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe notice material path');
 let current=root;for(const part of relative.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Notice material symlink rejected');}
 if(!lstatSync(current).isFile())throw new Error('Notice material is not regular');return current;
}
function boundedOriginal(root:string,name:string,maximum:number,check:()=>void=()=>{}):Buffer {
 check();
 const filename=safeFile(root,name),fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 const identity=(st:BigIntStats)=>[st.dev,st.ino,st.mode,st.size,st.mtimeNs,st.ctimeNs,st.nlink].join(':');
 try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>BigInt(maximum))throw new Error('Notice original byte budget');const parts:Buffer[]=[];let size=0;
  for(;;){check();const block=Buffer.alloc(Math.min(65536,maximum-size+1));const count=readSync(fd,block,0,block.length,null);if(!count)break;size+=count;if(size>maximum)throw new Error('Notice original grew');parts.push(block.subarray(0,count));}
  if(BigInt(size)!==before.size||identity(before)!==identity(fstatSync(fd,{bigint:true}))||identity(before)!==identity(lstatSync(safeFile(root,name),{bigint:true})))throw new Error('Notice original identity drift');return Buffer.concat(parts,size);
 }finally{closeSync(fd);}
}
function registryMembers(name:string,version:string,provenance:Record<string,string>,metadata:Buffer,archive:Buffer,integrity:string,maximum:number){
 if(provenance.archiveIntegrity!==integrity)throw new Error('Notice archive immutable lock identity missing');
 const inspected=inspectRegistryLegalArchive({name,version,integrity},metadata,archive,maximum),original=JSON.parse(metadata.toString());
 if(original.gitHead!==(provenance.gitHead??provenance.sourceCommit)||original.dist?.tarball!==provenance.archiveUrl)throw new Error('Notice archive immutable source differs');
 // Count the complete decoded tar, including headers/padding, not just files.
 return {...inspected,expandedBytes:gunzipSync(archive,{maxOutputLength:maximum}).length};
}
function sourceIdentity(input:any,metadata:Buffer){
 const original=JSON.parse(metadata.toString()),declared=original.repository;
 const url=(typeof declared==='string'?declared:declared?.url)?.replace(/^git\+/u,'').replace(/^git@github.com:/u,'https://github.com/').replace(/^git:\/\/github.com\//u,'https://github.com/');
 const match=typeof url==='string'?/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url):undefined;
 if(!match||!/^[a-f0-9]{40}$/u.test(original.gitHead)||input?.repository!=='https://github.com/'+match[1]||input.commit!==original.gitHead||input.url!=='https://codeload.github.com/'+match[1]+'/tar.gz/'+original.gitHead)throw new Error('Notice exact source archive identity differs');
 const scope=typeof declared==='object'&&declared?.directory!==undefined?declared.directory:'';
 if(typeof scope!=='string'||scope&&(!scope.split('/').every((part:string)=>part&&part!=='.'&&part!=='..')||scope.includes('\\'))||input.packageDirectory!==scope)throw new Error('Notice source package scope differs');
 const prefix=input.archivePrefix??match[1]!.slice(match[1]!.indexOf('/')+1)+'-'+original.gitHead+'/';
 if(typeof prefix!=='string'||!new RegExp('^[A-Za-z0-9_.-]+-'+original.gitHead+'/$','u').test(prefix))throw new Error('Notice source archive prefix differs');return {scope,prefix};
}
type NoticeBudget={packed:number;expanded:number;attempts:number;end:number;verifier?:{path:string;root:Buffer;assertCurrent:()=>void};sources:Map<string,{members:Map<string,Buffer>;expandedBytes:number}>};
function normalNoticeVerifier(stage:string,budget:NoticeBudget){
 if(budget.verifier){budget.verifier.assertCurrent();return budget.verifier;}
 const root=path.resolve(stage,'..','notice-tools'),plan=reviewedNoticeVerifierPlan();
 const rootStat=lstatSync(root,{bigint:true});if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||realpathSync(root)!==root)throw new Error('Notice verifier canonical owned directory required');
 const rootIdentity=[rootStat.dev,rootStat.ino,rootStat.mode].join(':');
 const check=()=>{if(Date.now()>=budget.end)throw new Error('Notice verifier shared deadline');};
 const receiptRaw=boundedOriginal(root,'acquisition.original.json',4*1024**2,check),receipt=JSON.parse(receiptRaw.toString('utf8'));
 const {originals}=noticeVerifierReceiptOriginals(receipt),checked=['acquisition.original.json'];
 const read=(name:string,maximum:number)=>boundedOriginal(root,name,maximum,check);
 for(const ref of originals){const raw=read(ref.path,ref.bytes);if(raw.length!==ref.bytes||hash(raw)!==ref.sha256)throw new Error('Notice verifier original bytes differ');checked.push(ref.path);}
 verifyNoticeVerifierHttpOriginals(receipt,read);
 const trust=read(plan.trustedRoot.path,plan.trustedRoot.bytes);
 const identity=(name:string)=>{const st=lstatSync(safeFile(root,name),{bigint:true});return [st.dev,st.ino,st.mode,st.size,st.mtimeNs,st.ctimeNs,st.nlink].join(':');};
 const retainedIdentities=checked.map(name=>[name,identity(name)] as const);
 const assertCurrent=()=>{const current=lstatSync(root,{bigint:true});if(!current.isDirectory()||current.isSymbolicLink()||realpathSync(root)!==root||[current.dev,current.ino,current.mode].join(':')!==rootIdentity)throw new Error('Notice verifier owned directory changed');if(Date.now()>=budget.end)throw new Error('Notice verifier shared deadline');for(const [name,before]of retainedIdentities)if(identity(name)!==before)throw new Error('Notice verifier retained original changed');};
 budget.verifier={path:path.join(root,plan.executable.path),root:trust,assertCurrent};assertCurrent();return budget.verifier;
}
function signedSourceMetadata(input:any,metadata:Buffer,archive:Buffer,integrity:string,read:(ref:any,max:number)=>Buffer,budget:NoticeBudget,workRoot:string){
 if(!input?.attestation)return {metadata};
 const original=JSON.parse(metadata.toString()),policy=input.attestation.policy;
 // The signed repository must also be the registry artifact's declared repo.
 // Source archive selection remains the same exact sourceIdentity projection.
 const projected=Buffer.from(JSON.stringify({...original,gitHead:input.commit}));sourceIdentity(input,projected);
 if(original.gitHead!==undefined&&original.gitHead!==input.commit)throw new Error('Attested metadata source conflict');
 if(policy?.packageName!==original.name||policy?.packageVersion!==original.version)throw new Error('Attestation package declaration differs');
 if(policy?.repository!==(input.repository??'').replace(/^https:\/\/github\.com\//u,'')||policy?.commit!==input.commit)throw new Error('Attestation policy source differs');
 const response=read(input.attestation.response,512*1024),trustedRoot=read(input.attestation.trustedRoot,512*1024);
 const tools=normalNoticeVerifier(workRoot,budget);if(!tools.root.equals(trustedRoot))throw new Error('Notice verifier trusted root original differs');
 if(input.attestation.verificationOriginal)read(input.attestation.verificationOriginal,1024*1024);
 const verified=verifyNoticeSourceAttestation({policy,artifact:archive,integrity,response,trustedRoot,verifierPath:tools.path,workRoot,remainingMilliseconds:()=>budget.end-Date.now()});
 tools.assertCurrent();
 if(verified.commit!==input.commit)throw new Error('Verified source commit differs');
 return {metadata:projected,attestation:{policy,response,trustedRoot,verificationOriginal:verified.verificationOriginal}};
}
function sourceProof(input:any,metadata:Buffer,read:(ref:any,max:number)=>Buffer,budget:NoticeBudget){
 const identity=sourceIdentity(input,metadata),archive=read(input.archive,SOURCE_ARCHIVE_PACKED_BYTES),key=input.repository+'@'+input.commit+':'+identity.prefix+':'+hash(archive);
 let proof=budget.sources.get(key);
 if(proof)return {...proof,scope:identity.scope,archive};
 budget.packed+=archive.length;if(budget.packed>REGISTRY_LEGAL_ORIGINAL_LIMITS.groupPackedBytes)throw new Error('Notice aggregate archive byte budget');
 const raw=gunzipSync(archive,{maxOutputLength:REGISTRY_LEGAL_ORIGINAL_LIMITS.groupExpandedBytes-budget.expanded}),entries=parseTar(raw,{expandedBytes:raw.length,members:20000,gnuLongNames:true,gitArchiveCommit:input.commit}),members=new Map<string,Buffer>();
 const prefix=identity.prefix;
 for(const row of entries){if(row.path===prefix.slice(0,-1)&&row.type==='directory')continue;if(!row.path.startsWith(prefix))throw new Error('Notice source archive root differs');if(row.type==='file')members.set(row.path.slice(prefix.length),Buffer.from(row.content));}
 budget.expanded+=raw.length;proof={members,expandedBytes:raw.length};budget.sources.set(key,proof);return {...proof,scope:identity.scope,archive};
}
/** Collect a complete final README license section, never an SPDX/link-only hint.
 * The original whole README remains the byte-bound inventory object. This text
 * predicate confers neither package ownership nor legal clearance. */
export function completeEmbeddedNotice(bytes:Buffer,declared:unknown):boolean {
 if(bytes.length>4*1024*1024||!Buffer.from(bytes.toString('utf8')).equals(bytes))return false;
 const text=bytes.toString('utf8').replace(/\r\n/gu,'\n');
 const sections=[...text.matchAll(/^(?:#{1,6}[ \t]+(?:Licen[cs]e|Licen[cs]e \(MIT\)|MIT License|ISC License)[ \t]*#*[ \t]*|(?:Licen[cs]e|Licen[cs]e \(MIT\)|MIT License|ISC License)[ \t]*\n[-=]{3,}[ \t]*)$/gimu)];
 if(sections.length!==1)return false;
 let section=text.slice(sections[0]!.index!+sections[0]![0].length).trim();
 if(declared==='MIT')section=section.replace(/^This software is licensed under the MIT License\.[ \t]*\n+/u,'');
 // Markdown reference definitions are non-rendered scaffolding, not grant
 // prose. Strip only an entire final block of canonical HTTP(S) definitions.
 const references=section.match(/\n\n((?:\[[A-Za-z0-9_-]+\]: https?:\/\/[^\s]+\n?)+)$/u);
 if(references&&references[1]!.trim().split('\n').every(line=>{try{const url=new URL(line.slice(line.indexOf(']: ')+3));return !url.username&&!url.password;}catch{return false;}}))section=section.slice(0,references.index).trim();
 // Additional sections, restrictions, badges, or prose remain unresolved.
 if(/^#{1,6}\s/mu.test(section))return false;
 const original=Buffer.from(section);
 const root=fileURLToPath(new URL('../../',import.meta.url));
 if(declared==='MIT'&&!explicitLicenseConflicts(bytes,'MIT').length){
  const standard=readFileSync(path.join(root,'packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt'));
  if(verifyMitGrantText(original,standard))return true;
  // Reviewed punctuation variant: only these two normative quoted terms differ.
  // The whole grant and actual holder still pass the canonical MIT verifier.
  const variant=section.replace(/^\(The MIT License\)\n+/u,'');
  if(!/\(the\s+'Software'\)/u.test(variant)||!variant.includes("PROVIDED 'AS IS'"))return false;
  return verifyMitGrantText(Buffer.from(variant.replace(/\(the\s+'Software'\)/u,'(the "Software")').replace("PROVIDED 'AS IS'",'PROVIDED "AS IS"')),standard);
 }
 if(declared==='ISC'&&!explicitLicenseConflicts(bytes,'ISC').length)return verifyIscGrantText(original,readFileSync(path.join(root,'packages/xpod-cli/licenses/native/collection/objects/b29f8b01452350c20dd1af16ef83b598fea3053578ccc1c7a0ef40e57be2620f.txt')),declared);
 return false;
}
function actualOriginalTerm(name:string,bytes:Buffer,license:unknown):boolean {
 return /(?:^|\/)(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/iu.test(name)||(/(?:^|\/)(?:readme)(?:[._-]|$)/iu.test(name)&&completeEmbeddedNotice(bytes,license));
}
function hasArchiveTerms(files:readonly {sourcePath:string}[],members:ReadonlyMap<string,Buffer>,license:unknown):boolean {
 return files.some(row=>{const bytes=members.get(row.sourcePath);return bytes!==undefined&&bytes.length>0&&actualOriginalTerm(row.sourcePath,bytes,license);});
}
function originalMember(file:any,registry:ReadonlyMap<string,Buffer>,source?:ReturnType<typeof sourceProof>):Buffer|undefined {
 if(file.sourceOrigin===undefined||file.sourceOrigin==='registry')return registry.get(file.sourcePath);
 if(file.sourceOrigin!=='source-archive'||!source)throw new Error('Notice original origin missing');
 const directory=path.posix.dirname(file.sourcePath);if(directory!=='.'&&directory!==source.scope)throw new Error('Notice original outside declared package/root scope');
 return source.members.get(file.sourcePath);
}
function nativePayload(inspected:ReturnType<typeof inspectRegistryLegalArchive>):boolean {
 return Array.isArray(inspected.manifest.os)||Array.isArray(inspected.manifest.cpu)||inspected.entries.some((row:any)=>row.type==='file'&&(row.path.endsWith('.node')||row.content.subarray(0,4).equals(Buffer.from([127,69,76,70]))||row.content.subarray(0,2).equals(Buffer.from('MZ'))));
}
function supplementTerms(files:any[],registry:ReadonlyMap<string,Buffer>,license:unknown,source:ReturnType<typeof sourceProof>|undefined,native:boolean){
 const registryTerms=hasArchiveTerms(files.filter(row=>row.sourceOrigin!=='source-archive'),registry,license),sourceTerms=source&&hasArchiveTerms(files.filter(row=>row.sourceOrigin==='source-archive'),source.members,license);
 if(!registryTerms&&!sourceTerms)throw new Error('Registry notice original terms member missing');
 return registryTerms||!!sourceTerms&&!native;
}
const locatedTerms=(record:{originals:readonly unknown[];supplements:readonly any[]})=>record.originals.length>0||record.supplements.some(row=>row.originalTermsLocated!==false);
/** Adds originals to one material index; it does not confer publication or legal clearance. */
function collectOriginalPackages(stage:string) {
 const records=new Map<string,{name:string;version:string;placements:string[];originals:{path:string;sha256:string;bytes:number}[];supplements:unknown[]}>();
 const packages=path.join(stage,'provenance/packages');
 for(const filename of readdirSync(packages).sort()){
  const inventory=JSON.parse(readFileSync(safeFile(packages,filename),'utf8'));const manifest=JSON.parse(readFileSync(safeFile(stage,inventory.path+'/package.json'),'utf8'));
  if(manifest.name!==inventory.name||manifest.version!==inventory.version)throw new Error('Notice package identity drift');
  if(!Array.isArray(inventory.files))throw new Error('Invalid original package inventory');
  const actualFiles:string[]=[];const visit=(relative:string)=>{const directory=path.join(stage,inventory.path,relative);for(const name of readdirSync(directory)){if(name==='node_modules')continue;const next=relative?relative+'/'+name:name;const stat=lstatSync(path.join(directory,name));if(stat.isSymbolicLink())throw new Error('Original package symlink rejected');if(stat.isDirectory())visit(next);else if(stat.isFile())actualFiles.push(next);else throw new Error('Original package nonregular member');}};visit('');
  const declared=inventory.files.map((row:{path:string})=>row.path);if(new Set(declared).size!==declared.length||actualFiles.sort().join('\n')!==declared.sort().join('\n'))throw new Error('Original package inventory is incomplete');
  const key=manifest.name+'@'+manifest.version;
  if(!records.has(key))records.set(key,{name:manifest.name,version:manifest.version,placements:[],originals:[],supplements:[]});const record=records.get(key)!;record.placements.push(inventory.path);
  for(const row of inventory.files){const bytes=readFileSync(safeFile(stage,inventory.path+'/'+row.path));if(bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error('Original package inventory drift');if(actualOriginalTerm(row.path,bytes,manifest.license))record.originals.push({path:inventory.path+'/'+row.path,sha256:row.sha256,bytes:row.bytes});}
 }
 return records;
}
export function attachPhysicalNotices(stage:string,supplementDirectories:string[],registryLock?:Buffer):void {
 const output=path.join(stage,'provenance/terms');if(existsSync(output))throw new Error('Notice material output exists');
 const records=collectOriginalPackages(stage);
 const lock=registryLock?registryLegalLockEntries(registryLock):undefined;const budget:NoticeBudget={packed:0,expanded:0,attempts:0,end:Date.now()+120000,sources:new Map()};
 const objects=new Map<string,Buffer>();
 const retain=(bytes:Buffer)=>{const sha256=hash(bytes);objects.set(sha256,bytes);return {object:'objects/'+sha256+'.txt',bytes:bytes.length,sha256};};
 const registryLockOriginal=registryLock?retain(registryLock):undefined;const inputs:{indexSHA256:string;entries:number}[]=[];
 for(const directory of supplementDirectories){
  const indexBytes=lock?boundedOriginal(directory,'index.json',4*1024**2):readFileSync(safeFile(directory,'index.json'));const index=JSON.parse(indexBytes.toString());if(index.schemaVersion!==1||!Array.isArray(index.entries))throw new Error('Invalid notice supplement index');inputs.push({indexSHA256:hash(indexBytes),entries:index.entries.length});
  for(const entry of index.entries){
   const record=records.get(entry.name+'@'+entry.version);if(!record)continue;
   if(typeof entry.name!=='string'||typeof entry.version!=='string'||!Array.isArray(entry.files)||!entry.files.length)throw new Error('Invalid notice supplement identity');
   const provenance:Record<string,string>={};
   for(const key of ['registryUrl','archiveUrl','archiveIntegrity','gitHead','noticeUrl','repositoryUrl','sourceCommit','sourceUrl','tag'] as const){const value=entry.provenance?.[key];if(value===undefined||value===null)continue;if(typeof value!=='string')throw new Error('Invalid notice provenance field');if(key.endsWith('Url')){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe original notice URL');}if(['gitHead','sourceCommit'].includes(key)&&!/^[a-f0-9]{40}$/u.test(value))throw new Error('Invalid notice commit');if(key==='archiveIntegrity'&&!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value))throw new Error('Invalid original registry integrity');provenance[key]=value;}
   if(!provenance.noticeUrl||(!provenance.gitHead&&!provenance.sourceCommit))throw new Error('Immutable original notice authority missing');
   let archiveMembers:Map<string,Buffer>|undefined;let registryOriginals:unknown;let archiveLicense:unknown;let source:ReturnType<typeof sourceProof>|undefined;let sourceOriginals:unknown;let native=false;
   if(lock){
    if(++budget.attempts>REGISTRY_LEGAL_ORIGINAL_LIMITS.groupAttempts)throw new Error('Notice archive attempt budget');
    const integrity=lock.get(entry.name+'@'+entry.version);
    if(!integrity||provenance.archiveIntegrity!==integrity)throw new Error('Notice archive immutable lock identity missing');
    const readRef=(ref:any,maximum:number)=>{if(!ref||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>maximum||!/^[a-f0-9]{64}$/u.test(ref.sha256))throw new Error('Notice archive reference invalid');const bytes=boundedOriginal(directory,ref.path,maximum);if(bytes.length!==ref.bytes||hash(bytes)!==ref.sha256)throw new Error('Notice archive reference drift');return bytes;};
    const archive=readRef(entry.registryOriginals?.archive,REGISTRY_LEGAL_ORIGINAL_LIMITS.packagePackedBytes),metadata=readRef(entry.registryOriginals?.metadata,REGISTRY_LEGAL_ORIGINAL_LIMITS.metadataBytes);
    budget.packed+=archive.length;if(budget.packed>REGISTRY_LEGAL_ORIGINAL_LIMITS.groupPackedBytes)throw new Error('Notice aggregate archive byte budget');
    const signed=signedSourceMetadata(entry.sourceOriginals,metadata,archive,integrity,readRef,budget,stage);
    const inspected=registryMembers(entry.name,entry.version,provenance,signed.metadata,archive,integrity,Math.min(REGISTRY_LEGAL_ORIGINAL_LIMITS.packageExpandedBytes,REGISTRY_LEGAL_ORIGINAL_LIMITS.groupExpandedBytes-budget.expanded));
    if(signed.attestation)sourceIdentity(entry.sourceOriginals,Buffer.from(JSON.stringify({...inspected.manifest,gitHead:entry.sourceOriginals.commit})));
    budget.expanded+=inspected.expandedBytes;registryOriginals={archive:retain(archive),metadata:retain(metadata)};archiveLicense=inspected.manifest.license;native=nativePayload(inspected);
    if(entry.sourceOriginals){source=sourceProof(entry.sourceOriginals,signed.metadata,readRef,budget);sourceOriginals={repository:entry.sourceOriginals.repository,commit:entry.sourceOriginals.commit,url:entry.sourceOriginals.url,packageDirectory:entry.sourceOriginals.packageDirectory,...(entry.sourceOriginals.archivePrefix?{archivePrefix:entry.sourceOriginals.archivePrefix}:{}),archive:retain(source.archive),...(signed.attestation?{attestation:{policy:signed.attestation.policy,response:retain(signed.attestation.response),trustedRoot:retain(signed.attestation.trustedRoot),verificationOriginal:retain(signed.attestation.verificationOriginal)}}:{})};}
    archiveMembers=new Map();for(const row of inspected.entries){if(row.type!=='file')continue;archiveMembers.set(row.path.slice(8),Buffer.from(row.content));}
   }
   const files=entry.files.map((file:{sourcePath:string;object:string;sha256:string;sourceOrigin?:string})=>{if(typeof file.sourcePath!=='string'||!file.sourcePath||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256)||file.object!=='objects/'+file.sha256+'.txt')throw new Error('Invalid notice original object binding');const bytes=lock?boundedOriginal(directory,file.object,4*1024**2):readFileSync(safeFile(directory,file.object));if(hash(bytes)!==file.sha256||!bytes.length)throw new Error('Notice original hash mismatch');if(archiveMembers){const member=originalMember(file,archiveMembers,source);if(!member||!member.equals(bytes))throw new Error('Notice archive member differs');}objects.set(file.sha256,bytes);return {sourcePath:file.sourcePath,object:file.object,sha256:file.sha256,bytes:bytes.length,...(file.sourceOrigin?{sourceOrigin:file.sourceOrigin}:{})};});
   const originalTermsLocated=archiveMembers?supplementTerms(files,archiveMembers,archiveLicense,source,native):true;
   record.supplements.push({provenance,files,...(registryOriginals?{registryOriginals,originalTermsLocated}:{}),...(sourceOriginals?{sourceOriginals}:{}),...(!originalTermsLocated?{nativeContentsTermsPending:true}:{})});
  }
 }
 mkdirSync(path.join(output,'objects'),{recursive:true});for(const [digest,bytes] of objects)writeFileSync(path.join(output,'objects',digest+'.txt'),bytes,{flag:'wx'});
 const notice=['Third-party original material inventory','', 'Original package files and their notices are preserved without license replacement. Supplemental original terms and their immutable sources are indexed in provenance/terms/index.json. Native release/source/terms material is retained separately in provenance/native. This inventory is not a legal-clearance statement.',''];
 for(const record of records.values()){notice.push(record.name+'@'+record.version);for(const original of record.originals)notice.push('  Original: '+original.path);for(const supplement of record.supplements as {files:{object:string;sourcePath:string}[]}[])for(const original of supplement.files)notice.push('  Supplemental original: provenance/terms/'+original.object+' ('+original.sourcePath+')');if(!locatedTerms(record))notice.push('  Original named terms not located; audit remains pending.');}
 writeFileSync(path.join(stage,'NOTICE'),notice.join('\n')+'\n',{flag:'wx'});
 writeFileSync(path.join(output,'index.json'),JSON.stringify({schemaVersion:1,status:'original-material-collection',legalClearance:false,...(registryLockOriginal?{registryLockOriginal}:{}),supplementInputs:inputs,entries:[...records.values()],missingNamedOriginalTerms:[...records.values()].filter(r=>!locatedTerms(r)).map(r=>({name:r.name,version:r.version}))},null,2)+'\n',{flag:'wx'});
}

/** Re-derive original inventories instead of trusting an empty missing-material claim. */
export function verifyPhysicalNotices(stage:string, requireComplete=false):void {
 const index=JSON.parse(readFileSync(safeFile(stage,'provenance/terms/index.json'),'utf8'));
 if(index.schemaVersion!==1||index.status!=='original-material-collection'||index.legalClearance!==false||!Array.isArray(index.entries))throw new Error('Invalid original notice material index');
 const readRetained=(ref:any,max:number)=>{if(!ref||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>max||!/^[a-f0-9]{64}$/u.test(ref.sha256)||ref.object!=='objects/'+ref.sha256+'.txt')throw new Error('Invalid registry notice retained reference');const bytes=boundedOriginal(stage,'provenance/terms/'+ref.object,max);if(bytes.length!==ref.bytes||hash(bytes)!==ref.sha256)throw new Error('Registry notice retained drift');return bytes;};
 const lock=index.registryLockOriginal?registryLegalLockEntries(readRetained(index.registryLockOriginal,4*1024**2)):undefined;const budget:NoticeBudget={packed:0,expanded:0,attempts:0,end:Date.now()+120000,sources:new Map()};
 const actual=collectOriginalPackages(stage);const seen=new Set<string>();const missing:{name:string;version:string}[]=[];
 for(const entry of index.entries){
  const key=entry.name+'@'+entry.version,record=actual.get(key);
  if(!record||seen.has(key)||JSON.stringify(entry.placements)!==JSON.stringify(record.placements)||JSON.stringify(entry.originals)!==JSON.stringify(record.originals)||!Array.isArray(entry.supplements))throw new Error('Actual original notice inventory mismatch');
  seen.add(key);
  for(const supplement of entry.supplements){
   const provenance=supplement.provenance;
   if(!provenance||typeof provenance.noticeUrl!=='string'||(!/^[a-f0-9]{40}$/u.test(provenance.gitHead??'')&&!/^[a-f0-9]{40}$/u.test(provenance.sourceCommit??''))||!Array.isArray(supplement.files)||!supplement.files.length)throw new Error('Notice immutable source binding missing');
   const url=new URL(provenance.noticeUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe original notice URL');
   if(requireComplete&&!lock)throw new Error('Strict notice completeness requires retained registry originals');
   let members:Map<string,Buffer>|undefined;let archiveLicense:unknown;let source:ReturnType<typeof sourceProof>|undefined;let native=false;
   if(lock){if(++budget.attempts>REGISTRY_LEGAL_ORIGINAL_LIMITS.groupAttempts)throw new Error('Notice archive attempt budget');const integrity=lock.get(key);if(!integrity)throw new Error('Notice archive lock identity missing');const archive=readRetained(supplement.registryOriginals?.archive,REGISTRY_LEGAL_ORIGINAL_LIMITS.packagePackedBytes),metadata=readRetained(supplement.registryOriginals?.metadata,REGISTRY_LEGAL_ORIGINAL_LIMITS.metadataBytes);budget.packed+=archive.length;if(budget.packed>REGISTRY_LEGAL_ORIGINAL_LIMITS.groupPackedBytes)throw new Error('Notice aggregate archive byte budget');const signed=signedSourceMetadata(supplement.sourceOriginals,metadata,archive,integrity,readRetained,budget,stage);const inspected=registryMembers(entry.name,entry.version,provenance,signed.metadata,archive,integrity,Math.min(REGISTRY_LEGAL_ORIGINAL_LIMITS.packageExpandedBytes,REGISTRY_LEGAL_ORIGINAL_LIMITS.groupExpandedBytes-budget.expanded));if(signed.attestation)sourceIdentity(supplement.sourceOriginals,Buffer.from(JSON.stringify({...inspected.manifest,gitHead:supplement.sourceOriginals.commit})));archiveLicense=inspected.manifest.license;native=nativePayload(inspected);budget.expanded+=inspected.expandedBytes;if(supplement.sourceOriginals)source=sourceProof(supplement.sourceOriginals,signed.metadata,readRetained,budget);members=new Map();for(const row of inspected.entries){if(row.type!=='file')continue;members.set(row.path.slice(8),Buffer.from(row.content));}}
   if(members){const located=supplementTerms(supplement.files,members,archiveLicense,source,native);if(supplement.originalTermsLocated!==located||Boolean(supplement.nativeContentsTermsPending)!==!located)throw new Error('Notice original terms coverage scope differs');}
   for(const row of supplement.files){if(!/^[a-f0-9]{64}$/u.test(row.sha256)||row.object!=='objects/'+row.sha256+'.txt'||typeof row.sourcePath!=='string'||!row.sourcePath)throw new Error('Invalid original notice object');const bytes=lock||requireComplete?boundedOriginal(stage,'provenance/terms/'+row.object,4*1024**2):readFileSync(safeFile(stage,'provenance/terms/'+row.object));if(!bytes.length||bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error('Actual original notice object drift');if(members&&!originalMember(row,members,source)?.equals(bytes))throw new Error('Notice archive member differs');}
  }
  if(!locatedTerms({originals:record.originals,supplements:entry.supplements}))missing.push({name:record.name,version:record.version});
 }
 if(seen.size!==actual.size||JSON.stringify(index.missingNamedOriginalTerms)!==JSON.stringify(missing))throw new Error('Actual missing notice inventory mismatch');
 if(requireComplete&&missing.length)throw new Error('Original notice material remains incomplete');
}
