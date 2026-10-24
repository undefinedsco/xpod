import type {CandidateServiceRelationshipContract} from './qlever-sdk-service-relationship';
import type {QleverSdkOuterExecutorContract} from './qlever-sdk-outer-authority';
export interface GitHubSourceBinding {readonly path:string;readonly sha256:string;readonly ref?:'run-head';readonly reviewedSha256?:readonly string[]}
export interface GitHubSourceBindingGroup {readonly candidateServiceRelationship?:CandidateServiceRelationshipContract;readonly outerExecutor?:QleverSdkOuterExecutorContract;readonly selectors:readonly GitHubSourceBinding[];readonly secondarySelectors?:readonly GitHubSourceBinding[];readonly sourceBindings:readonly GitHubSourceBinding[]}
export const sourceBindingKey=(binding:GitHubSourceBinding):string=>(binding.ref??'source')+':'+binding.path;
/** The requested role union comes only from declared secondary selectors of
 * actual primary candidates. Promotion is allowed only when each candidate
 * already owns that role with one consistent mandatory SHA. */
function primaryCandidates(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBindingGroup[]{
 const candidates=groups.filter(group=>group.selectors.every(binding=>observed.get(sourceBindingKey(binding))===binding.sha256));
 if(!candidates.length)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return candidates;
}
function sharedSecondary(candidates:readonly GitHubSourceBindingGroup[]):Readonly<{roles:readonly GitHubSourceBinding[];owned:ReadonlyMap<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>}> {
 const selectors=new Map(candidates.flatMap(group=>(group.secondarySelectors??[]).map(binding=>[sourceBindingKey(binding),binding] as const)));
 const owned=new Map<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>();
 for(const group of candidates){
  const rows=new Map<string,GitHubSourceBinding>();
  for(const row of [...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings]){
   const key=sourceBindingKey(row);if(!selectors.has(key))continue;
   if(rows.has(key)&&rows.get(key)!.sha256!==row.sha256)throw Error('Independent GitHub origin: conflicting owned secondary original');
   rows.set(key,row);
  }
  if(rows.size!==selectors.size)throw Error('Independent GitHub origin: missing owned secondary original');
  owned.set(group,rows);
 }
 return {roles:[...selectors.values()],owned};
}
type SecondaryPlan=ReturnType<typeof sharedSecondary>;
interface BindingGroupIndex {
 readonly entries:readonly Readonly<{group:GitHubSourceBindingGroup;position:number;selectors:readonly(readonly[string,string])[]}>[];
 readonly plans:Map<string,SecondaryPlan>;
}
const immutableGroupIndexes=new WeakMap<readonly GitHubSourceBindingGroup[],BindingGroupIndex>();
function dataProperty(value:object,key:string,optional=false):boolean {
 const descriptor=Object.getOwnPropertyDescriptor(value,key);
 return descriptor?'value'in descriptor:optional&&!(key in value);
}
/** Opt in authored static declarations only. Mutable callers keep the original
 * live scan; an observation or a successful selection is never cached. */
export function freezeGitHubSourceBindingGroups(groups:readonly GitHubSourceBindingGroup[]):void {
 if(immutableGroupIndexes.has(groups))return;
 let dataOnly=true;
 for(const group of groups){
  dataOnly=dataOnly&&dataProperty(group,'selectors')&&dataProperty(group,'sourceBindings')&&dataProperty(group,'secondarySelectors',true);
  for(const rows of [group.selectors,group.secondarySelectors??[],group.sourceBindings]){
   for(const row of rows){
    const prototype=Object.getPrototypeOf(row);
    dataOnly=dataOnly&&(prototype===Object.prototype||prototype===null)&&dataProperty(row,'path')&&dataProperty(row,'sha256')&&dataProperty(row,'ref',true)&&typeof row.path==='string'&&typeof row.sha256==='string'&&(row.ref===undefined||row.ref==='run-head');
    Object.freeze(row);
   }
   Object.freeze(rows);
  }
  Object.freeze(group);
 }
 Object.freeze(groups);
 if(!dataOnly)return;
 immutableGroupIndexes.set(groups,{entries:groups.map((group,position)=>({group,position,selectors:group.selectors.map(row=>[sourceBindingKey(row),row.sha256] as const)})),plans:new Map()});
}
function resolutionPlan(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):Readonly<{candidates:readonly GitHubSourceBindingGroup[]}&SecondaryPlan> {
 // Optional absent fields must retain live semantics if a caller changes the
 // shared Object prototype after declarations were frozen.
 const index=('ref'in Object.prototype||'secondarySelectors'in Object.prototype)?undefined:immutableGroupIndexes.get(groups);
 if(!index){const candidates=primaryCandidates(groups,observed);return {candidates,...sharedSecondary(candidates)};}
 const entries=index.entries.filter(entry=>entry.selectors.every(([key,sha256])=>observed.get(key)===sha256));
 if(!entries.length)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 const candidates=entries.map(entry=>entry.group),key=entries.map(entry=>entry.position).join(',');
 let plan=index.plans.get(key);
 if(!plan){
  plan=sharedSecondary(candidates);
  // The declaration count bounds storage even for unusual combinations of
  // primary observations. Eviction changes cost, never selection semantics.
  if(index.plans.size>=index.entries.length)index.plans.delete(index.plans.keys().next().value!);
  index.plans.set(key,plan);
 }
 return {candidates,...plan};
}
export function secondaryGitHubSourceBindingSelectors(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBinding[]{
 return [...resolutionPlan(groups,observed).roles];
}
/** Entire reviewed workflow/source recipes are selected atomically. Missing
 * observed secondary originals never fall back to declaration-only values. */
export function selectGitHubSourceBindingGroup(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):GitHubSourceBindingGroup {
 const {candidates,roles,owned}=resolutionPlan(groups,observed);
 const matches=candidates.filter(group=>roles.every(role=>observed.get(sourceBindingKey(role))===owned.get(group)!.get(sourceBindingKey(role))!.sha256));
 if(matches.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return matches[0]!;
}
