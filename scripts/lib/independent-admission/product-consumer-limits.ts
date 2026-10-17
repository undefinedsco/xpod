import {PUBLICATION_DISK_LIMITS} from './publication-disk-budget';
/** AFS carries the actual bounded verifier-tool source kit. Other consumer
 * artifacts keep the existing small original-byte transport ceiling. */
export function productConsumerOriginalLimits(module:'client'|'cli'|'api'|'css'|'afs'){
 if(!['client','cli','api','css','afs'].includes(module))throw Error('Canonical consumer module required');
 return Object.freeze(module==='afs'?{
  packedBytes:PUBLICATION_DISK_LIMITS.outerPackedBytes,expandedBytes:PUBLICATION_DISK_LIMITS.outerExpandedBytes,
  members:50000,originalMembers:50000,smallMemberBytes:16*1024**2,memberBytes:512*1024**2,originalBytes:PUBLICATION_DISK_LIMITS.outerExpandedBytes-4*1024**2,manifestBytes:4*1024**2,
 }:{packedBytes:96*1024**2,expandedBytes:72*1024**2,members:2100,originalMembers:2000,smallMemberBytes:16*1024**2,memberBytes:16*1024**2,originalBytes:64*1024**2,manifestBytes:2*1024**2});
}
