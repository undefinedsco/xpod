import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const require=createRequire(import.meta.url);
const pack=require('../../run-npm-pack.cjs');
const {sanitizeManifest}=require('../../prepare-package-manifest.cjs');
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function need(value:unknown,why:string):asserts value{if(!value)throw Error('Service pack manifest replay: '+why);}
/** Byte/decision replay only. The private caller supplies actual retained bodies
 * and source reads; ordinary JSON invoking this function never issues a cap. */
export function replayServicePackManifest(input:{collection:any;repoRoot:string;temporaryRoot:string;afterRoot:Buffer;seedManifest:Buffer;finalManifest:Buffer;publicManifests:ReadonlyMap<string,Buffer>;readObject:(reference:any)=>Buffer;assertWorkspaceSource?:(relative:string,raw:Buffer)=>void}){
 const {collection}=input;need(collection?.schemaVersion===1&&collection.kind==='actual-service-pack-manifest-inputs'&&collection.authorityVerified===false&&Array.isArray(collection.records)&&collection.records.length<=512,'bounded same-call collection');
 const plain=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
 const absolute=(value:any)=>typeof value==='string'&&value.startsWith('/')&&path.posix.normalize(value)===value&&!/[\u0000-\u001f\u007f]/u.test(value);
 need(absolute(input.repoRoot)&&absolute(input.temporaryRoot),'canonical producer roots');
 const roles=new Set(['actual-prepack-root-input','actual-prepack-policy','actual-bundled-root-probe','workspace-selection-root','workspace-selection-member','seed-packed-root-manifest','root-after-workspace-removal','actual-node-resolution','actual-resolution-parent-manifest','actual-manifest-exposure','nested-conflict-manifest','root-after-actual-resolutions','selected-installed-bundled-manifest','actual-public-tar-manifest','public-package-source-manifest','actual-final-selected-inputs','actual-final-projected-manifest']);
 const rows=collection.records.filter((row:any)=>plain(row)&&roles.has(row.role));let cursor=0;
 const take=(role:string,kind:string)=>{const row=rows[cursor++];need(row?.role===role&&row.kind===kind,'ordered actual input role '+role);return row;};
 const object=(ref:any)=>{need(plain(ref)&&Object.keys(ref).sort().join(',')==='bytes,path,sha256'&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=4*1024**2&&ref.path==='objects/'+ref.sha256+'.original'&&/^[a-f0-9]{64}$/u.test(ref.sha256),'plain metadata object reference');const raw=input.readObject(ref);need(Buffer.isBuffer(raw)&&raw.length===ref.bytes&&sha(raw)===ref.sha256,'actual metadata object differs');return raw;};
 const manifest=(file:string,role:string)=>{const row=take(role,'actual-manifest-read');need(row.path===file&&absolute(row.canonicalPath)&&Array.isArray(row.identity)&&row.identity.length===6&&row.identity.every((value:any)=>typeof value==='string'&&/^[0-9]+$/u.test(value)),'actual manifest read path/identity');const raw=object(row.reference);need(Number(row.identity[3])===raw.length&&(BigInt(row.identity[2])&0o170000n)===0o100000n,'actual regular manifest size');const relative=path.posix.relative(input.repoRoot,file);if(relative==='package.json'||/^packages\/[^/]+\/package\.json$/u.test(relative))input.assertWorkspaceSource?.(relative,raw);return {row,raw,value:JSON.parse(raw.toString())};};
 const same=(actual:unknown,expected:unknown,why:string)=>need(isDeepStrictEqual(actual,expected),why);
 const prepack=manifest(input.repoRoot+'/package.json','actual-prepack-root-input');need(prepack.raw.equals(input.afterRoot),'prepack input differs from actual after-root');
 const policy=take('actual-prepack-policy','actual-resolution-event');need(typeof policy.includePlatformPackages==='boolean'&&Object.keys(policy).sort().join(',')==='includePlatformPackages,kind,role','explicit actual prepack policy');
 const expectedSeed=sanitizeManifest(prepack.value,{includePlatformPackages:policy.includePlatformPackages});
 const seed=JSON.parse(input.seedManifest.toString());same(seed,expectedSeed,'actual seed differs from sole sanitizer');
 const dependencies=pack.getBundledLocalDependencies(input.repoRoot,'service',{readManifest:(file:string,role:string)=>manifest(file,role).value},(name:string,optional:boolean)=>{
  const row=take('actual-bundled-root-probe','actual-resolution-event');need(row.name===name&&row.optional===optional&&row.path===input.repoRoot+'/node_modules/'+name&&typeof row.exists==='boolean'&&(optional||row.exists),'actual installed selection probe');need(row.exists?absolute(row.canonicalPath):row.canonicalPath===null,'actual selected canonical root');return row.exists?row.canonicalPath:undefined;
 });
 const seedRow=rows[cursor];need(seedRow?.role==='seed-packed-root-manifest'&&absolute(seedRow.path),'actual unpacked seed read');
 const packageDir=path.posix.dirname(seedRow.path),unpack=path.posix.relative(input.temporaryRoot,packageDir);need(/^xpod-pack-[a-zA-Z0-9_-]+\/unpack\/package$/u.test(unpack),'fixed actual pack temporary layout');
 const unpacked=manifest(packageDir+'/package.json','seed-packed-root-manifest');need(unpacked.raw.equals(input.seedManifest),'seed body and actual unpacked original differ');
 const removed=manifest(packageDir+'/package.json','root-after-workspace-removal');same(removed.value,pack.removeWorkspaceDependenciesManifest(seed),'workspace removal differs from sole projection');
 let unresolvedProbeCount=0;
 const planned=pack.planExposedRuntimeDependencies({packageDir,dependencies,manifest:removed.value,
  readManifest:(file:string,role:string)=>manifest(file,role).value,
  resolveInstalled:(source:string,name:string)=>{
   const row=take('actual-node-resolution','actual-resolution-event');need(row.source===source&&row.name===name&&Array.isArray(row.probes)&&row.probes.length>0&&row.probes.length<=128,'ordered actual Node resolution');const seen=new Set();
   row.probes.forEach((probe:any,index:number)=>{need(plain(probe)&&Object.keys(probe).sort().join(',')==='exists,path'&&absolute(probe.path)&&probe.path.endsWith('/'+name)&&typeof probe.exists==='boolean'&&!seen.has(probe.path)&&(!probe.exists||index===row.probes.length-1),'actual first existing resolution probe');seen.add(probe.path);});
   need(row.probes[row.probes.length-1].exists?absolute(row.resolvedRoot):row.resolvedRoot===null,'actual resolution result layout');unresolvedProbeCount++;return row.resolvedRoot??undefined;
  },onExposure:(event:any)=>{const actual=take('actual-manifest-exposure','actual-resolution-event');same(actual,{kind:'actual-resolution-event',...event},'exposure edge differs from sole traversal');},
 });
 const resolved=manifest(packageDir+'/package.json','root-after-actual-resolutions');same(resolved.value,planned.manifest,'actual resolved root differs from sole traversal');
 const selected:any[]=[];const publicNames=new Set<string>();
 for(const dependency of dependencies){
  if(dependency.patchedRuntime){const actual=manifest(dependency.sourcePackageRoot+'/package.json','selected-installed-bundled-manifest');need(actual.value.name===dependency.name&&typeof actual.value.version==='string'&&actual.value.version.length>0,'actual installed package name/version');selected.push({name:dependency.name,patchedRuntime:true,version:actual.value.version});}
  else {const publicRecord=take('actual-public-tar-manifest','actual-buffer'),raw=object(publicRecord.reference),bodyManifest=input.publicManifests.get(dependency.name);need(bodyManifest&&bodyManifest.equals(raw)&&!publicNames.has(dependency.name),'actual unique public body/manifest');publicNames.add(dependency.name);need(JSON.parse(raw.toString()).name===dependency.name,'actual public package name');const source=manifest(dependency.sourcePackageRoot+'/package.json','public-package-source-manifest');need(source.value.name===dependency.name,'actual public source package name');selected.push({name:dependency.name,patchedRuntime:false});}
 }
 need(publicNames.size===input.publicManifests.size,'no extra public body');
 const actualSelected=take('actual-final-selected-inputs','actual-resolution-event');same(actualSelected.dependencies,selected,'final inputs differ from actual selected manifests');
 const projected=pack.projectServicePackManifest(seed,planned.edges,selected);same(projected,pack.projectPackedManifest(planned.manifest,selected,'service'),'single complete projection stages disagree');
 const actualFinal=object(take('actual-final-projected-manifest','actual-buffer').reference);const expected=Buffer.from(JSON.stringify(projected,null,2)+'\n');need(actualFinal.equals(expected)&&actualFinal.equals(input.finalManifest),'final body manifest differs from actual same-call projection');need(cursor===rows.length,'unexpected repeated/unconsumed projection input');
 return Object.freeze({candidateVersion:projected.version,afterRootSha256:sha(input.afterRoot),seedManifestSha256:sha(input.seedManifest),finalManifestSha256:sha(input.finalManifest),finalManifestOriginal:Buffer.from(actualFinal),selectedPackages:selected.length,recordedResolutionProbes:unresolvedProbeCount,recordedManifestProjectionReplayed:true as const,packInputResolutionVerified:false as const,pending:Object.freeze(['service-pack-installed-input-source-and-absence-probe-custody-unverified'])});
}
