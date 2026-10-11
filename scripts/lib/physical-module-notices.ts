import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function safeFile(root:string,relative:string):string {
 if(!relative||path.isAbsolute(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe notice material path');
 let current=root;for(const part of relative.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw new Error('Notice material symlink rejected');}
 if(!lstatSync(current).isFile())throw new Error('Notice material is not regular');return current;
}
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
  for(const row of inventory.files){const bytes=readFileSync(safeFile(stage,inventory.path+'/'+row.path));if(bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error('Original package inventory drift');if(/(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-]|$)/iu.test(row.path))record.originals.push({path:inventory.path+'/'+row.path,sha256:row.sha256,bytes:row.bytes});}
 }
 return records;
}
export function attachPhysicalNotices(stage:string,supplementDirectories:string[]):void {
 const output=path.join(stage,'provenance/terms');if(existsSync(output))throw new Error('Notice material output exists');
 const records=collectOriginalPackages(stage);
 const objects=new Map<string,Buffer>();const inputs:{indexSHA256:string;entries:number}[]=[];
 for(const directory of supplementDirectories){
  const indexBytes=readFileSync(safeFile(directory,'index.json'));const index=JSON.parse(indexBytes.toString());if(index.schemaVersion!==1||!Array.isArray(index.entries))throw new Error('Invalid notice supplement index');inputs.push({indexSHA256:hash(indexBytes),entries:index.entries.length});
  for(const entry of index.entries){
   const record=records.get(entry.name+'@'+entry.version);if(!record)continue;
   if(typeof entry.name!=='string'||typeof entry.version!=='string'||!Array.isArray(entry.files)||!entry.files.length)throw new Error('Invalid notice supplement identity');
   const provenance:Record<string,string>={};
   for(const key of ['registryUrl','archiveUrl','archiveIntegrity','gitHead','noticeUrl','repositoryUrl','sourceCommit','sourceUrl','tag'] as const){const value=entry.provenance?.[key];if(value===undefined||value===null)continue;if(typeof value!=='string')throw new Error('Invalid notice provenance field');if(key.endsWith('Url')){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe original notice URL');}if(['gitHead','sourceCommit'].includes(key)&&!/^[a-f0-9]{40}$/u.test(value))throw new Error('Invalid notice commit');if(key==='archiveIntegrity'&&!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value))throw new Error('Invalid original registry integrity');provenance[key]=value;}
   if(!provenance.noticeUrl||(!provenance.gitHead&&!provenance.sourceCommit))throw new Error('Immutable original notice authority missing');
   const files=entry.files.map((file:{sourcePath:string;object:string;sha256:string})=>{if(typeof file.sourcePath!=='string'||!file.sourcePath||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256)||file.object!=='objects/'+file.sha256+'.txt')throw new Error('Invalid notice original object binding');const bytes=readFileSync(safeFile(directory,file.object));if(hash(bytes)!==file.sha256||!bytes.length)throw new Error('Notice original hash mismatch');objects.set(file.sha256,bytes);return {sourcePath:file.sourcePath,object:file.object,sha256:file.sha256,bytes:bytes.length};});
   record.supplements.push({provenance,files});
  }
 }
 mkdirSync(path.join(output,'objects'),{recursive:true});for(const [digest,bytes] of objects)writeFileSync(path.join(output,'objects',digest+'.txt'),bytes,{flag:'wx'});
 const notice=['Third-party original material inventory','', 'Original package files and their notices are preserved without license replacement. Supplemental original terms and their immutable sources are indexed in provenance/terms/index.json. Native release/source/terms material is retained separately in provenance/native. This inventory is not a legal-clearance statement.',''];
 for(const record of records.values()){notice.push(record.name+'@'+record.version);for(const original of record.originals)notice.push('  Original: '+original.path);for(const supplement of record.supplements as {files:{object:string;sourcePath:string}[]}[])for(const original of supplement.files)notice.push('  Supplemental original: provenance/terms/'+original.object+' ('+original.sourcePath+')');if(!record.originals.length&&!record.supplements.length)notice.push('  Original named terms not located; audit remains pending.');}
 writeFileSync(path.join(stage,'NOTICE'),notice.join('\n')+'\n',{flag:'wx'});
 writeFileSync(path.join(output,'index.json'),JSON.stringify({schemaVersion:1,status:'original-material-collection',legalClearance:false,supplementInputs:inputs,entries:[...records.values()],missingNamedOriginalTerms:[...records.values()].filter(r=>!r.originals.length&&!r.supplements.length).map(r=>({name:r.name,version:r.version}))},null,2)+'\n',{flag:'wx'});
}

/** Re-derive original inventories instead of trusting an empty missing-material claim. */
export function verifyPhysicalNotices(stage:string, requireComplete=false):void {
 const index=JSON.parse(readFileSync(safeFile(stage,'provenance/terms/index.json'),'utf8'));
 if(index.schemaVersion!==1||index.status!=='original-material-collection'||index.legalClearance!==false||!Array.isArray(index.entries))throw new Error('Invalid original notice material index');
 const actual=collectOriginalPackages(stage);const seen=new Set<string>();const missing:{name:string;version:string}[]=[];
 for(const entry of index.entries){
  const key=entry.name+'@'+entry.version,record=actual.get(key);
  if(!record||seen.has(key)||JSON.stringify(entry.placements)!==JSON.stringify(record.placements)||JSON.stringify(entry.originals)!==JSON.stringify(record.originals)||!Array.isArray(entry.supplements))throw new Error('Actual original notice inventory mismatch');
  seen.add(key);
  for(const supplement of entry.supplements){
   const provenance=supplement.provenance;
   if(!provenance||typeof provenance.noticeUrl!=='string'||(!/^[a-f0-9]{40}$/u.test(provenance.gitHead??'')&&!/^[a-f0-9]{40}$/u.test(provenance.sourceCommit??''))||!Array.isArray(supplement.files)||!supplement.files.length)throw new Error('Notice immutable source binding missing');
   const url=new URL(provenance.noticeUrl);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Unsafe original notice URL');
   for(const row of supplement.files){if(!/^[a-f0-9]{64}$/u.test(row.sha256)||row.object!=='objects/'+row.sha256+'.txt'||typeof row.sourcePath!=='string'||!row.sourcePath)throw new Error('Invalid original notice object');const bytes=readFileSync(safeFile(stage,'provenance/terms/'+row.object));if(!bytes.length||bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error('Actual original notice object drift');}
  }
  if(!record.originals.length&&!entry.supplements.length)missing.push({name:record.name,version:record.version});
 }
 if(seen.size!==actual.size||JSON.stringify(index.missingNamedOriginalTerms)!==JSON.stringify(missing))throw new Error('Actual missing notice inventory mismatch');
 if(requireComplete&&missing.length)throw new Error('Original notice material remains incomplete');
}
