import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { verifyAcquiredMetadata } from '../../acquire-independent-product-input';
import limits from '../module-artifact-limits.json';
import { githubOriginFacts, githubOriginOriginals, isNativeGitHubOrigin } from './github-origin';
import { nativeOriginalLifetime } from './native-original-lifetime';
import { openBoundOriginalFile } from './bound-original-file';
import type { CollectedArtifactMember } from './artifact-contract';
import type { CollectedNativeOriginalsCapability, CollectedNativeOriginalsView, NativeAdmissionOriginalCollectionInput } from './native-originals';
const issued = new WeakMap<object, CollectedNativeOriginalsView>();
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
  if (!isNativeGitHubOrigin(input.githubOrigin) || !origin || !['.github/workflows/agentfs-native-acceptance.yml','.github/workflows/build-qlever-macos-runtime.yml','.github/workflows/css-module-product.yml'].includes(origin.workflowPath) || !origin.target) fail('registered independent native origin required');
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
    || custody.archive.sha256 !== facts.artifactSha256 || custody.archive.bytes > limits.packedBytes) fail('origin/acquisition mismatch');
  const rows: (CollectedArtifactMember & {kind: string})[] = custody.inventory?.members;
  if (!Array.isArray(rows) || rows.length > limits.members || !Number.isSafeInteger(custody.inventory.expandedBytes)
    || custody.inventory.expandedBytes > limits.expandedBytes) fail('bounded native inventory required');
  const files = rows.filter(row => row.kind === 'file');
  if (!files.length || files.some(row => !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(row.path)
    || row.path.split('/').some(part => part === '.' || part === '..')
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > limits.shardBytes
    || !/^[a-f0-9]{64}$/u.test(row.sha256))) fail('bounded exact native member inventory required');
  const parent = fs.realpathSync(os.tmpdir()), free = fs.statfsSync(parent, {bigint:true});
  if (free.bavail * free.bsize < BigInt(custody.inventory.expandedBytes + limits.freeFloorBytes + limits.queueReserveBytes)) fail('native projection free-space floor insufficient');
  const snapshot = fs.mkdtempSync(path.join(parent, 'xpod-native-originals-'));
  const readers = new Map<string, ReturnType<typeof openBoundOriginalFile>>();
  const archivePath = path.join(root, 'artifact.zip');
  const lifetime=nativeOriginalLifetime({snapshot,
    closeReaders(){for(const reader of readers.values()) reader.close();readers.clear();},
    verifyRetainedOriginal(){
      const result=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),archivePath,facts.artifactSha256,
        String(limits.packedBytes),String(limits.expandedBytes),String(limits.members)],{timeout:limits.timeoutMs,maxBuffer:32*1024**2});
      if(result.error||result.status!==0||!isDeepStrictEqual(JSON.parse(result.stdout).members,rows)) fail('retained native ZIP required before compaction');
    },
  });
  let returnedBytes=0, calls=0;
  const rangeDeadline=Date.now()+limits.timeoutMs;
  const boundedRange=(name:string,offset:number,length:number)=>{
    lifetime.assertReadable();
    if(Date.now()>rangeDeadline || ++calls>Math.max(1024,Math.ceil(custody.inventory.expandedBytes/limits.rangeBytes)*8)
      || (returnedBytes+=length)>custody.inventory.expandedBytes*4+1024*1024) return fail('native aggregate range/time budget exceeded');
    return readerForRange(name,offset,length);
  };
  let readerForRange:(name:string,offset:number,length:number)=>Buffer=()=>fail('native reader not initialized');
  try {
    const projected = inspectArtifact([path.resolve(import.meta.dir, '../inspect-product-artifact.py'), archivePath,
      facts.artifactSha256, String(limits.packedBytes), String(limits.expandedBytes), String(limits.members),
      '--selection-stdin', snapshot, 'native-material-originals'], {timeout:limits.timeoutMs,maxBuffer:32*1024**2,
      input:Buffer.from(JSON.stringify(files.map(row => ({path:row.path,destination:row.path,bytes:row.bytes,sha256:row.sha256}))))});
    if (projected.error || projected.status !== 0 || projected.signal) fail('native original ZIP projection failed');
    const actual = JSON.parse(projected.stdout);
    if (!isDeepStrictEqual(actual.members, rows) || actual.expandedBytes !== custody.inventory.expandedBytes
      || actual.selectedMembersProjected !== files.length || actual.innerArchiveExpanded !== false) fail('complete native ZIP inventory changed');
    for (const row of files) fs.chmodSync(path.join(snapshot,row.path),0o400);
    const reader = (name:string) => {
      const row = files.find(item => item.path === name); if (!row) return fail('registered native original required');
      let found=readers.get(name);
      if (!found) {
        // Bound descriptors without making large source archives into Buffers.
        if (readers.size >= 32) { const first=readers.keys().next().value!; readers.get(first)!.close(); readers.delete(first); }
        found=openBoundOriginalFile(path.join(snapshot,name),row); readers.set(name,found);
      }
      return found;
    };
    readerForRange=(name,offset,length)=>reader(name).readRange(offset,length);
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
          String(limits.packedBytes),String(limits.expandedBytes),String(limits.members)],{timeout:limits.timeoutMs,maxBuffer:32*1024**2});
        if(before.error||before.status!==0||!isDeepStrictEqual(JSON.parse(before.stdout).members,rows)) return fail('native archive changed');
        const value=await operation({path:archivePath,identity:Object.freeze({bytes:custody.archive.bytes,sha256:facts.artifactSha256})});
        const after=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),archivePath,facts.artifactSha256,
          String(limits.packedBytes),String(limits.expandedBytes),String(limits.members)],{timeout:limits.timeoutMs,maxBuffer:32*1024**2});
        if(after.error||after.status!==0||!isDeepStrictEqual(JSON.parse(after.stdout).members,rows)) return fail('native archive changed during scan');
        return value;
      }});
    const cap=Object.freeze({}) as CollectedNativeOriginalsCapability; issued.set(cap,view); compactors.set(cap,()=>lifetime.compact()); return cap;
  } catch(error) { for(const reader of readers.values()) reader.close(); fs.rmSync(snapshot,{recursive:true,force:true}); throw error; }
}
