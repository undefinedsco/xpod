import {noticeVerifierOriginalNames,noticeVerifierReceiptOriginals,verifyNoticeVerifierHttpOriginals} from '../notice-source-attestation';
import {createHash} from 'node:crypto';
import {isModuleNativeBuildOriginalName,MODULE_NATIVE_BUILD_PREFIX} from './module-native-build-originals';
import type {OriginalReadBudget} from './artifact-contract';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { PUBLICATION_DISK_LIMITS } from './publication-disk-budget';
import limits from '../module-artifact-limits.json';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lazyZipOriginals } from './lazy-zip-originals';
import type { CollectedArtifactMember } from './artifact-contract';
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const fail = (reason: string): never => { throw Error('Module source originals: ' + reason); };
export async function collectModuleSourceOriginals(input: {
  archivePath: string; archiveSha256: string;
  inventory: { members: readonly (CollectedArtifactMember & { kind: string })[]; expandedBytes: number };
  producer: any;
}) {
  const reference = input.producer?.sourceMaterials;
  if (!reference) {if(input.producer?.nativeBuildOriginals||input.producer?.noticeVerifierOriginals)fail('native sidecar requires the normal source master');return undefined;}
  if (reference.path !== 'source-materials/materials.json' || reference.bytes > limits.metadataBytes) fail('registered bounded source master required');
  const rows = input.inventory.members.filter(row => row.kind === 'file' && row.path.startsWith('source-materials/'));
  const toolsPrefix='source-materials/notice-tools/',toolRows=input.inventory.members.filter(row=>row.kind==='file'&&row.path.startsWith(toolsPrefix)),toolReference=input.producer.noticeVerifierOriginals;
  let toolNames:readonly string[]=[];const target=input.producer.context?.target,architecture=target==='linux-x64'?'x64':target==='linux-arm64'?'arm64':undefined;
  if(toolReference||toolRows.length){if(!architecture||toolReference?.path!==toolsPrefix+'acquisition.original.json')fail('notice verifier registered target/master required');toolNames=noticeVerifierOriginalNames('linux',architecture);if(toolRows.length!==toolNames.length||toolNames.some(name=>toolRows.filter(row=>row.path===toolsPrefix+name).length!==1))fail('notice verifier complete fixed original set required');const master=toolRows.find(row=>row.path===toolReference.path);if(master?.bytes!==toolReference.bytes||master?.sha256!==toolReference.sha256)fail('notice verifier master/inventory mismatch');}
  if(toolRows.reduce((sum,row)=>sum+row.bytes,0)>64*MiB)fail('notice verifier shared retained reservation exceeded');
  const isTool=(name:string)=>name.startsWith(toolsPrefix)&&toolNames.includes(name.slice(toolsPrefix.length));

  if(rows.some(row=>row.path.startsWith(MODULE_NATIVE_BUILD_PREFIX)) && input.producer?.nativeBuildOriginals?.path!==MODULE_NATIVE_BUILD_PREFIX+'controlled-build-materials.json')fail('orphan controlled native sidecar');
  if (!rows.length || rows.length > limits.sourceMaterialFiles || rows.some(row => !isTool(row.path) && !isModuleNativeBuildOriginalName(row.path) && !/^source-materials\/(?:materials\.json|(?:source|dependencies|toolchain)-\d{4}\.tar|(?:source|dependencies|toolchain)-inventory-\d{4}\.json|outputs-\d{4}\.json)$/u.test(row.path)
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > (isTool(row.path)&&[toolsPrefix+'gh',toolsPrefix+'gh.official.tar.gz'].includes(row.path)||isModuleNativeBuildOriginalName(row.path)&&!row.path.endsWith('.json')||row.path.endsWith('.tar') ? limits.shardBytes : limits.metadataBytes))) fail('registered source original layout/budget required');
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (total > limits.sourceMaterialBytes || input.inventory.expandedBytes > PUBLICATION_DISK_LIMITS.outerExpandedBytes) fail('unified source/archive aggregate budget exceeded');
  for (const [domain, maximum] of [['source', limits.sourceBytes], ['dependencies', limits.dependencyBytes], ['toolchain', limits.toolchainBytes]] as const) {
    if (rows.filter(row => row.path.startsWith('source-materials/' + domain + '-') && row.path.endsWith('.tar')).reduce((sum, row) => sum + row.bytes, 0) > maximum) fail('source domain byte budget exceeded');
  }
  const master = rows.filter(row => row.path === reference.path);
  if (master.length !== 1 || master[0]!.bytes !== reference.bytes || master[0]!.sha256 !== reference.sha256) fail('source master receipt/inventory mismatch');
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'xpod-module-source-originals-'));
  let cache: ReturnType<typeof lazyZipOriginals> | undefined;
  const dispose = () => { cache?.close(); fs.rmSync(root, {recursive:true,force:true}); };
  try {
    const {inspectArtifact}=createRequire(import.meta.url)('../product-artifact-command.cjs');
    const inspected=inspectArtifact([path.resolve(import.meta.dir,'../inspect-product-artifact.py'),input.archivePath,input.archiveSha256,
      String(PUBLICATION_DISK_LIMITS.outerPackedBytes),String(PUBLICATION_DISK_LIMITS.outerExpandedBytes),String(limits.members)],
      {timeout:limits.timeoutMs,maxBuffer:32*MiB});
    if(inspected.error||inspected.status!==0||inspected.signal) fail('complete source ZIP inventory verification failed');
    const inventory=JSON.parse(inspected.stdout);
    if(!isDeepStrictEqual(inventory.members,input.inventory.members)||inventory.expandedBytes!==input.inventory.expandedBytes) fail('complete source ZIP inventory changed');
    cache = lazyZipOriginals({archivePath:input.archivePath,archiveSha256:input.archiveSha256,root,members:rows});
    const bound = cache;
    if(toolReference){
      const small=(name:string,maximum:number)=>{const full=toolsPrefix+name,row=toolRows.find(row=>row.path===full);if(!row||row.bytes>maximum)fail('bounded notice verifier metadata required');const body=Buffer.alloc(row!.bytes);for(let offset=0;offset<body.length;offset+=limits.rangeBytes)bound.readRange(full,offset,Math.min(limits.rangeBytes,body.length-offset)).copy(body,offset);return body;};
      const receipt=JSON.parse(small('acquisition.original.json',limits.metadataBytes).toString('utf8')),projection=noticeVerifierReceiptOriginals(receipt,'linux',architecture!);
      for(const ref of projection.originals){const row=toolRows.find(row=>row.path===toolsPrefix+ref.path);if(row?.bytes!==ref.bytes||row?.sha256!==ref.sha256)fail('notice verifier original/inventory mismatch');const digest=createHash('sha256');for(let offset=0;offset<ref.bytes;offset+=limits.rangeBytes)digest.update(bound.readRange(toolsPrefix+ref.path,offset,Math.min(limits.rangeBytes,ref.bytes-offset)));if(digest.digest('hex')!==ref.sha256)fail('notice verifier complete original hash differs');}
      verifyNoticeVerifierHttpOriginals(receipt,small,'linux',architecture!);
    }

    return Object.freeze({ members: Object.freeze(rows.map(({ path, bytes, sha256, mode }) => Object.freeze({ path, bytes, sha256, mode }))),
      readRange(name:string,offset:number,length:number,budget?:OriginalReadBudget) { return bound.readRange(name,offset,length,budget); },
      readSmall(name:string,maximum:number,budget?:OriginalReadBudget) {
        const row=rows.find(value=>value.path===name);
        if (!row || !Number.isSafeInteger(maximum) || maximum<0 || maximum>8*MiB || row.bytes>maximum) return fail('bounded source manifest/inventory required');
        const bytes=Buffer.alloc(row.bytes);
        for(let offset=0;offset<row.bytes;offset+=limits.rangeBytes) bound.readRange(name,offset,Math.min(limits.rangeBytes,row.bytes-offset)).copy(bytes,offset);
        return bytes;
      },
      assertCustody(){bound.assertRetainedOriginal();},
      compact() { bound.assertRetainedOriginal(); dispose(); },
      dispose,
    });
  } catch(error) { dispose(); throw error; }
}
