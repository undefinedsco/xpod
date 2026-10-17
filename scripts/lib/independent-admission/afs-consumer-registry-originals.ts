import {afsConsumerBudget} from '../afs-consumer-budget';
import {requiredAfsVerifierRegistryOriginalCoordinates,type AfsConsumerOriginalInput} from './afs-consumer-originals';
import {observeVerifierRegistryOriginal,REGISTRY_LEGAL_ORIGINAL_LIMITS} from './legal-registry-originals';
/** Plans from actual tool tar manifests and immutable Git, then observes only
 * the issuer's fixed patched-package scope. No caller coordinate list. */
export async function observeAfsConsumerVerifierRegistryOriginals(input:AfsConsumerOriginalInput,operationDeadline?:number):Promise<readonly unknown[]> {
 const deadline=Math.min(operationDeadline??Infinity,Date.now()+afsConsumerBudget(input.stage).verifierRegistryObservationSeconds*1000);
 if(!Number.isFinite(deadline)||deadline<=Date.now())throw Error('AFS verifier registry observation deadline pending');
 const check=()=>{if(Date.now()>deadline)throw Error('AFS verifier registry whole-group observation deadline exceeded');};
 const bounded={...input,readOriginal:(name:string,maximum:number)=>{check();const body=input.readOriginal(name,maximum);check();return body;},readOriginalRange:(name:string,offset:number,length:number)=>{check();const body=input.readOriginalRange(name,offset,length);check();return body;}};
 const plan=requiredAfsVerifierRegistryOriginalCoordinates(bounded);
 if(plan.pending.length)throw Error('AFS verifier registry original plan pending: '+plan.pending.join('; '));
 const capabilities:unknown[]=[];
 for(const coordinate of plan.coordinates){
  if(deadline-Date.now()<REGISTRY_LEGAL_ORIGINAL_LIMITS.requestTimeoutMs)throw Error('AFS verifier registry whole-group observation deadline pending');
  capabilities.push(await observeVerifierRegistryOriginal({source:input.source,...coordinate}));
 }
 if(Date.now()>deadline)throw Error('AFS verifier registry whole-group observation deadline exceeded');
 return Object.freeze(capabilities);
}
