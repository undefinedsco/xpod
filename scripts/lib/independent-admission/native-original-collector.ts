import { PUBLICATION_DISK_LIMITS } from './publication-disk-budget';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { verifyAcquiredMetadata } from '../../acquire-independent-product-input';
import limits from '../module-artifact-limits.json';
import { githubOriginFacts, githubOriginOriginals, isNativeGitHubOrigin } from './github-origin';
import { nativeOriginalLifetime } from './native-original-lifetime';
import { lazyZipOriginals } from './lazy-zip-originals';
import type { CollectedArtifactMember } from './artifact-contract';
import type { CollectedNativeOriginalsCapability, CollectedNativeOriginalsView, NativeAdmissionOriginalCollectionInput } from './native-originals';
const issued = new WeakMap<object, CollectedNativeOriginalsView>();
const custodyAssertions=new WeakMap<object,()=>void>();
export function assertCollectedNativeOriginalCustody(value:unknown):void{
 if(!value||typeof value!=='object'||!issued.has(value)||!custodyAssertions.has(value))fail('real retained native originals required');
 custodyAssertions.get(value as object)!();
}
const compactors = new WeakMap<object,()=>boolean>();
export function compactCollectedNativeOriginals(value:unknown):boolean {
  if(value===null || typeof value!=='object' || !compactors.has(value)) return fail('issued native originals capability required');
  return compactors.get(value)!();
}
const fail = (reason: string): never => { throw Error('Native original custody: ' + reason); };
const { inspectArtifact } = createRequire(import.meta.url)('../product-artifact-command.cjs');
export function nativeOriginalsView(value: unknown): CollectedNativeOriginalsView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}
/** Only a separately observed native producer and its exact acquired ZIP can
 * issue byte custody. A normal module product is deliberately rejected. */
export async function collectNativeAdmissionOriginals(input: NativeAdmissionOriginalCollectionInput): Promise<CollectedNativeOriginalsCapability> {
  const origin = githubOriginFacts(input.githubOrigin);
  if (!isNativeGitHubOrigin(input.githubOrigin) || !origin || !['.github/workflows/agentfs-native-acceptance.yml','.github/workflows/build-qlever-macos-runtime.yml','.github/workflows/publish-qlever-runtime-sdk.yml','.github/workflows/css-module-product.yml','.github/workflows/css-native-products.yml'].includes(origin.workflowPath) || !origin.target) fail('registered independent native origin required');
  const facts = origin!;
  const root = path.resolve(input.acquisitionRoot);
  if (fs.realpathSync(root) !== root) fail('canonical acquisition root required');
  const receiptPath = path.join(root, 'receipt.json'), stat = fs.lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 ** 2) fail('bounded ordinary custody receipt required');
  const custody = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  verifyAcquiredMetadata(root, custody.metadata);
  if (custody.expectedSourceSha !== facts.sourceSha || custody.runHeadSha !== facts.runHeadSha
    || custody.runId !== facts.runId || custody.runAttempt !== facts.runAttempt || custody.artifactId !== facts.artifactId
    || custody.workflowPath !== facts.workflowPath || custody.archive?.path !== 'artifact.zip'
    || custody.archive.sha256 !== facts.artifactSha256 || custody.archive.bytes > PUBLICATION_DISK_LIMITS.outerPackedBytes) fail('origin/acquisition mismatch');
  const rows: (CollectedArtifactMember & {kind: string})[] = custody.inventory?.members;
  if (!Array.isArray(rows) || rows.length > limits.members || !Number.isSafeInteger(custody.inventory.expandedBytes)
    || custody.inventory.expandedBytes > PUBLICATION_DISK_LIMITS.outerExpandedBytes) fail('bounded native inventory required');
  const files = rows.filter(row => row.kind === 'file');
  if (!files.length || files.some(row => !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(row.path)
    || row.path.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.shardBytes
    || !/^[a-f0-9]{64}$/u.test(row.sha256))) fail('bounded exact native member inventory required');
  const parent=fs.realpathSync(os.tmpdir());
  const snapshot=fs.mkdtempSync(path.join(parent,'xpod-native-originals-'));
  const archivePath=path.join(root,'artifact.zip');
  let cache:ReturnType<typeof lazyZipOriginals>|undefined;
  const lifetime=nativeOriginalLifetime({snapshot,
    closeReaders(){cache?.close();},
    verifyRetainedOriginal(){if(!cache) fail('native cache unavailable'); cache!.assertRetainedOriginal();},
  });
  let returnedBytes=0, calls=0;
  let rangeIoMilliseconds=0;
  const boundedRange=(name:string,offset:number,length:number)=>{
    lifetime.assertReadable();
    if(!Number.isSafeInteger(length)||length<0||length>limits.rangeBytes) return fail('fixed 64KiB native range required');
    if(rangeIoMilliseconds>=limits.timeoutMs || ++calls>Math.max(1024,Math.ceil(custody.inventory.expandedBytes/limits.rangeBytes)*8)
      || (returnedBytes+=length)>custody.inventory.expandedBytes*4+1024*1024) return fail('native aggregate range/time budget exceeded');
    const started=Date.now();try{return readerForRange(name,offset,length);}finally{rangeIoMilliseconds+=Date.now()-started;}
  };
  let readerForRange:(name:string,offset:number,length:number)=>Buffer=()=>fail('native reader not initialized');
  try {
    const inspected=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),archivePath,facts.artifactSha256,
      String(PUBLICATION_DISK_LIMITS.outerPackedBytes),String(PUBLICATION_DISK_LIMITS.outerExpandedBytes),String(limits.members)],
      {timeout:limits.timeoutMs,maxBuffer:32*1024**2});
    if(inspected.error||inspected.status!==0||inspected.signal) fail('complete native ZIP inventory verification failed');
    const actual=JSON.parse(inspected.stdout);
    if(!isDeepStrictEqual(actual.members,rows)||actual.expandedBytes!==custody.inventory.expandedBytes) fail('complete native ZIP inventory changed');
    cache=lazyZipOriginals({archivePath,archiveSha256:facts.artifactSha256,root:snapshot,members:files});
    const bound=cache;
    readerForRange=(name,offset,length)=>bound.readRange(name,offset,length);
    const view:CollectedNativeOriginalsView=Object.freeze({origin:input.githubOrigin,originFacts:facts,
      members:Object.freeze(files.map(({path,bytes,sha256,mode})=>Object.freeze({path,bytes,sha256,mode}))),
      archive:Object.freeze({bytes:custody.archive.bytes,sha256:facts.artifactSha256}),
      metadataOriginals:Object.freeze(githubOriginOriginals(input.githubOrigin).map(row=>Object.freeze(row))),
      readOriginalRange(name:string,offset:number,length:number){return boundedRange(name,offset,length);},
      readOriginal(name:string,maximum:number){
        const row=files.find(item=>item.path===name);
        if (!row || !Number.isSafeInteger(maximum) || maximum<0 || maximum>8*1024**2 || row.bytes>maximum) return fail('bounded small native original required');
        const result=Buffer.alloc(row.bytes); for(let offset=0;offset<row.bytes;offset+=limits.rangeBytes)
          boundedRange(name,offset,Math.min(limits.rangeBytes,row.bytes-offset)).copy(result,offset);
        return result;
      },
      async withArchiveFile<T>(operation:(input:{readonly path:string;readonly identity:Readonly<{bytes:number;sha256:string}>})=>Promise<T>):Promise<T>{
        lifetime.assertReadable();
        // Full archive SHA and inventory are rechecked before and after the controlled
        // scanner. No archive path is recovered from a serialized capability.
        const before=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),archivePath,facts.artifactSha256,
          String(PUBLICATION_DISK_LIMITS.outerPackedBytes),String(PUBLICATION_DISK_LIMITS.outerExpandedBytes),String(limits.members)],{timeout:limits.timeoutMs,maxBuffer:32*1024**2});
        if(before.error||before.status!==0||!isDeepStrictEqual(JSON.parse(before.stdout).members,rows)) return fail('native archive changed');
        const value=await operation({path:archivePath,identity:Object.freeze({bytes:custody.archive.bytes,sha256:facts.artifactSha256})});
        const after=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),archivePath,facts.artifactSha256,
          String(PUBLICATION_DISK_LIMITS.outerPackedBytes),String(PUBLICATION_DISK_LIMITS.outerExpandedBytes),String(limits.members)],{timeout:limits.timeoutMs,maxBuffer:32*1024**2});
        if(after.error||after.status!==0||!isDeepStrictEqual(JSON.parse(after.stdout).members,rows)) return fail('native archive changed during scan');
        return value;
      }});
    const cap=Object.freeze({}) as CollectedNativeOriginalsCapability; issued.set(cap,view); custodyAssertions.set(cap,()=>bound.assertRetainedOriginal()); compactors.set(cap,()=>lifetime.compact()); return cap;
  } catch(error) { cache?.close(); fs.rmSync(snapshot,{recursive:true,force:true}); throw error; }
}
