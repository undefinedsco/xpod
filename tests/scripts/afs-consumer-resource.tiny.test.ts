import {test,expect} from 'bun:test';
import {afsConsumerDiskLayers,assertAfsConsumerDiskReservation} from '../../scripts/lib/independent-admission/afs-consumer-resource';
import {afsConsumerBudget} from '../../scripts/lib/afs-consumer-budget';
import limits from '../../scripts/lib/module-artifact-limits.json';
test('fresh harness live tree and cache coexist with immutable source kit and consumer writes',()=>{
 const layers=afsConsumerDiskLayers(123,'postpublish');
 expect(layers.originals).toBe(BigInt(limits.sourceMaterialBytes));
 expect(layers.live).toBe(BigInt(afsConsumerBudget('postpublish').freshHarnessLiveBytes)+123n);
 expect(layers.floor).toBe(BigInt(limits.freeFloorBytes));
 expect(()=>afsConsumerDiskLayers(-1,'prepublish')).toThrow();
});
test('actual filesystem preflight refuses an impossible reservation before creating evidence',()=>{
 expect(()=>assertAfsConsumerDiskReservation({evidenceParent:import.meta.dir,temporaryParent:import.meta.dir,consumerWriteBytes:Number.MAX_SAFE_INTEGER,stage:'prepublish'})).toThrow('resource pending');
});
