import {afsConsumerBudget} from '../afs-consumer-budget';
import {observeOfficialBun142Runtime,officialBun142RuntimeView,type OfficialBun142Target} from './legal-bun-runtime';
/** Source/runtime identity only; this operation grants no license clearance. */
export async function observeAfsConsumerRuntimeOriginals(target:string,stage:'prepublish'|'postpublish'):Promise<readonly unknown[]> {
 if(!['linux-x64','linux-arm64','darwin-x64','darwin-arm64'].includes(target))throw Error('Canonical AFS runtime target required');
 const deadline=Date.now()+afsConsumerBudget(stage).officialRuntimeObservationSeconds*1000;
 const capability=await observeOfficialBun142Runtime(target as OfficialBun142Target);
 const view=officialBun142RuntimeView(capability);
 if(Date.now()>deadline||view?.target!==target)throw Error('AFS official runtime original observation pending');
 return Object.freeze([capability]);
}
