import fs from 'node:fs';
import limits from '../module-artifact-limits.json';
import {afsConsumerBudget} from '../afs-consumer-budget';

/** Concurrent layers, rather than an estimate of compressed upload size. */
export function afsConsumerDiskLayers(consumerWriteBytes:number,stage:'prepublish'|'postpublish') {
  if(!Number.isSafeInteger(consumerWriteBytes)||consumerWriteBytes<0) throw Error('Invalid AFS consumer write reservation');
  return Object.freeze({originals:BigInt(limits.sourceMaterialBytes),
    live:BigInt(afsConsumerBudget(stage).freshHarnessLiveBytes)+BigInt(consumerWriteBytes),
    floor:BigInt(limits.freeFloorBytes)});
}
export function assertAfsConsumerDiskReservation(input:{evidenceParent:string;temporaryParent:string;consumerWriteBytes:number;stage:'prepublish'|'postpublish'}):void {
  const layers=afsConsumerDiskLayers(input.consumerWriteBytes,input.stage);
  const evidence=fs.statfsSync(input.evidenceParent,{bigint:true});
  const temporary=fs.statfsSync(input.temporaryParent,{bigint:true});
  const sameDevice=fs.statSync(input.evidenceParent,{bigint:true}).dev===fs.statSync(input.temporaryParent,{bigint:true}).dev;
  const evidenceRequired=layers.originals+layers.floor+(sameDevice?layers.live:0n);
  const temporaryRequired=layers.live+layers.floor;
  if(evidence.bavail*evidence.bsize<evidenceRequired || (!sameDevice&&temporary.bavail*temporary.bsize<temporaryRequired)) {
    throw Error('AFS verifier-kit originals plus fresh harness/install/cache, consumer write and floor resource pending');
  }
}
