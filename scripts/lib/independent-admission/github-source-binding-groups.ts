import type {CandidateServiceRelationshipContract} from './qlever-sdk-service-relationship';
import type {QleverSdkOuterExecutorContract} from './qlever-sdk-outer-authority';
export interface GitHubSourceBinding {readonly path:string;readonly sha256:string;readonly ref?:'run-head';readonly reviewedSha256?:readonly string[]}
export interface GitHubSourceBindingGroup {readonly candidateServiceRelationship?:CandidateServiceRelationshipContract;readonly outerExecutor?:QleverSdkOuterExecutorContract;readonly selectors:readonly GitHubSourceBinding[];readonly secondarySelectors?:readonly GitHubSourceBinding[];/** Explicit OPTIONAL refinement stages AFTER the strict secondarySelectors stage. Stage k roles are unioned only from candidates that survived every earlier stage, so a role the older recipes never owned is never requested. */readonly secondarySelectorStages?:readonly (readonly GitHubSourceBinding[])[];readonly sourceBindings:readonly GitHubSourceBinding[]}
export const sourceBindingKey=(binding:GitHubSourceBinding):string=>(binding.ref??'source')+':'+binding.path;
/** The requested role union comes only from declared secondary selectors of
 * actual primary candidates. Promotion is allowed only when each candidate
 * already owns that role with one consistent mandatory SHA. */
function primaryCandidates(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBindingGroup[]{
 const candidates=groups.filter(group=>group.selectors.every(binding=>observed.get(sourceBindingKey(binding))===binding.sha256));
 if(!candidates.length)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return candidates;
}
/** Union one stage's roles across candidates and require EVERY candidate to
 * already own each requested role with one consistent mandatory SHA. Stage 0
 * (secondarySelectors) and every later stage use this same validation, so a
 * missing or conflicting own role always refuses before any acquisition. */
function sharedSecondary(candidates:readonly GitHubSourceBindingGroup[]):Readonly<{roles:readonly GitHubSourceBinding[];owned:ReadonlyMap<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>}> {
 return stageUnion(candidates) as Readonly<{roles:readonly GitHubSourceBinding[];owned:ReadonlyMap<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>}>;
}
function stageUnion(candidates:readonly GitHubSourceBindingGroup[],stage=0):Readonly<{roles:readonly GitHubSourceBinding[];owned:ReadonlyMap<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>}> {
 const declared=stage===0?(group:GitHubSourceBindingGroup)=>group.secondarySelectors??[]:(group:GitHubSourceBindingGroup)=>(group.secondarySelectorStages??[])[stage-1]??[];
 const selectors=new Map(candidates.flatMap(group=>declared(group).map(binding=>[sourceBindingKey(binding),binding] as const)));
 const owned=new Map<GitHubSourceBindingGroup,ReadonlyMap<string,GitHubSourceBinding>>();
 for(const group of candidates){
  const rows=new Map<string,GitHubSourceBinding>();
  // A stage declaration REQUESTS a role; it never by itself proves mandatory
  // ownership. Proof must come from selectors, secondarySelectors or
  // sourceBindings, so a recipe that only names a future role and never carries
  // its original is rejected instead of self-certifying.
  for(const row of [...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings]){
   const key=sourceBindingKey(row);if(!selectors.has(key))continue;
   // Stage 0 is the ORIGINAL contract: secondarySelectors is both the request
   // and a legitimate owned-original declaration (the published recipes rely on
   // exactly that). Only a LATER stage may never self-certify, because there the
   // declaration is a purely prospective request.
   if(stage>0&&(group.secondarySelectorStages?.[stage-1]??[]).some(row=>sourceBindingKey(row)===key)&&
      ![...group.selectors,...(group.secondarySelectors??[]),...group.sourceBindings].some(row=>sourceBindingKey(row)===key))continue;
   if(rows.has(key)&&rows.get(key)!.sha256!==row.sha256)throw Error('Independent GitHub origin: conflicting owned secondary original');
   rows.set(key,row);
  }
  // Any declaration of a requested key, INCLUDING this stage, must agree with
  // the mandatory original. A group is internally inconsistent otherwise.
  for(const row of [...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings]){
   const key=sourceBindingKey(row);
   if(!selectors.has(key))continue;
   if(rows.has(key)&&rows.get(key)!.sha256!==row.sha256)throw Error('Independent GitHub origin: conflicting owned secondary original');
  }
  // EVERY survivor must own EVERY requested role, whether or not it is the one
  // that declared this stage. A candidate that never requested the role must
  // still carry its mandatory original: otherwise the role would be fetched
  // before ownership by all candidates is known, which is the never-future-GET
  // contract. There is no participation exception (SDK79 owns `wrapper` in
  // sourceBindings, so no exception is needed).
  if(rows.size!==selectors.size)throw Error('Independent GitHub origin: missing owned secondary original');
  owned.set(group,rows);
 }
 return {roles:[...selectors.values()],owned};
}
function declaredStageCount(groups:readonly GitHubSourceBindingGroup[]):number {
 return groups.reduce((count,group)=>Math.max(count,(group.secondarySelectorStages??[]).length),0);
}
/** Deterministic staged walk shared by the planner AND the final selector.
 *
 * Stage 0 is the unchanged secondarySelectors union. A later stage is only
 * ever computed from the candidates that survived every earlier stage, and is
 * only advanced past once every one of its roles has an actual observation that
 * matches that candidate's own declared SHA. A pre-filled future observation
 * therefore cannot prune anything before the earlier stage is fully proven. */
interface StagedWalk {
 readonly roles:readonly GitHubSourceBinding[];
 readonly complete:boolean;
 readonly survivors:readonly GitHubSourceBindingGroup[];
}
function stagedWalk(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):StagedWalk {
 const candidates=primaryCandidates(groups,observed);
 let survivors=candidates;
 // Stage 0 is the existing strict secondarySelectors stage; the explicit
 // optional stages follow it, so the total is one plus their declared count.
 const stages=1+declaredStageCount(groups);
 for(let stage=0;stage<stages;stage++){
  const {roles,owned}=stageUnion(survivors,stage);
  // An EMPTY stage (no candidate declares anything here) is not the end of the
  // walk: a later stage may still be declared. Only an empty FINAL stage means
  // every declared stage is resolved.
  if(!roles.length)continue;
  // Ownership is validated by stageUnion BEFORE any role is reported, so a
  // survivor that lacks a requested mandatory original refuses with zero reads.
  const pending=roles.filter(role=>!hasOwnObservation(observed,role));
  if(pending.length)return {roles:pending,complete:false,survivors};
  // Every earlier declared stage must already be fully OBSERVED before a later
  // one is considered, so a pre-filled future value can never skip ahead.
  if(stage>0){
   for(let prior=0;prior<stage;prior++){
    const earlier=stageUnion(survivors,prior).roles.filter(role=>!hasOwnObservation(observed,role));
    if(earlier.length)return {roles:earlier,complete:false,survivors};
   }
  }
  const matches=survivors.filter(group=>roles.every(role=>observed.get(sourceBindingKey(role))===owned.get(group)!.get(sourceBindingKey(role))!.sha256));
  if(!matches.length)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
  survivors=matches;
 }
 return {roles:[],complete:true,survivors};
}
/** A role is "observed" only when the key is actually present, even if the
 * stored value is empty, so a pre-filled undefined never counts as proof. */
function hasOwnObservation(observed:ReadonlyMap<string,string>,role:GitHubSourceBinding):boolean {
 const key=sourceBindingKey(role);
 if(!observed.has(key))return false;
 return typeof observed.get(key)==='string';
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
  dataOnly=dataOnly&&dataProperty(group,'selectors')&&dataProperty(group,'sourceBindings')&&dataProperty(group,'secondarySelectors',true)&&dataProperty(group,'secondarySelectorStages',true);
  const staged=group.secondarySelectorStages??[];
  dataOnly=dataOnly&&Array.isArray(staged);
  for(const stage of staged)dataOnly=dataOnly&&Array.isArray(stage);
  for(const rows of [group.selectors,group.secondarySelectors??[],...staged,group.sourceBindings]){
   for(const row of rows){
    const prototype=Object.getPrototypeOf(row);
    dataOnly=dataOnly&&(prototype===Object.prototype||prototype===null)&&dataProperty(row,'path')&&dataProperty(row,'sha256')&&dataProperty(row,'ref',true)&&typeof row.path==='string'&&typeof row.sha256==='string'&&(row.ref===undefined||row.ref==='run-head');
    Object.freeze(row);
   }
   Object.freeze(rows);
  }
  for(const stage of staged)Object.freeze(stage);
  Object.freeze(staged);
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
/** The ONE production acquisition helper. It is not a second selection engine:
 * it repeatedly asks the same planner for the roles still outstanding and then
 * hands the completed observation to the same final selector.
 *
 * Correctness rules:
 *  * a role is fetched at most once (`read` is only called for keys whose value
 *    is not already present in `observed`);
 *  * a planner answer whose roles are ALL already observed is a successful
 *    legacy outcome, not an error - selection proceeds without refetching;
 *  * the round count is bounded by the declared role count;
 *  * `checkDeadline` runs before and after every await, so an elapsed absolute
 *    budget can never be renewed between rounds;
 *  * everything else fails closed.
 */
export async function acquireOwnedSecondaryBindings(
 groups:readonly GitHubSourceBindingGroup[],
 observed:Map<string,string>,
 read:(binding:GitHubSourceBinding)=>Promise<string>,
 checkDeadline:()=>void,
):Promise<GitHubSourceBindingGroup> {
 const declaredRoles=new Set(groups.flatMap(group=>[...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings].map(row=>sourceBindingKey(row)))).size;
 const maximumRounds=declaredRoles+1;
 const requestedSoFar=new Set<string>();
 for(let round=0;round<maximumRounds;round++){
  checkDeadline();
  const outstanding=secondaryGitHubSourceBindingSelectors(groups,observed);
  if(!outstanding.length)break;
  // Only roles with no observation yet are fetched. Roles the planner still
  // reports but that are ALREADY observed mean it is time for final selection.
  const pending=outstanding.filter(binding=>!observed.has(sourceBindingKey(binding)));
  if(!pending.length)break;
  const fresh=pending.filter(binding=>!requestedSoFar.has(sourceBindingKey(binding)));
  if(!fresh.length)throw Error('Independent GitHub origin: immutable secondary group selector missing');
  for(const binding of fresh)requestedSoFar.add(sourceBindingKey(binding));
  const values=await Promise.all(fresh.map(async binding=>{
   const value=await read(binding);
   checkDeadline();
   if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))throw Error('Independent GitHub origin: immutable secondary group selector missing');
   return [sourceBindingKey(binding),value] as const;
  }));
  checkDeadline();
  for(const [key,value] of values)observed.set(key,value);
 }
 checkDeadline();
 return selectGitHubSourceBindingGroup(groups,observed);
}
export function secondaryGitHubSourceBindingSelectors(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBinding[]{
 // Recipes with NO explicit stages keep the exact original behaviour: one
 // strict secondarySelectors union over the primary candidates.
 if(declaredStageCount(groups)===0)return [...resolutionPlan(groups,observed).roles];
 // With explicit stages the SAME deterministic walk the final selector uses
 // reports the roles still outstanding, so a caller fetches them in order and
 // never requests a role an older candidate does not own.
 return [...stagedWalk(groups,observed).roles];
}
/** Entire reviewed workflow/source recipes are selected atomically. Missing
 * observed secondary originals never fall back to declaration-only values. */
export function selectGitHubSourceBindingGroup(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):GitHubSourceBindingGroup {
 // A recipe with NO explicit later stages keeps the exact original path,
 // including its strict stage-0 uniqueness requirement.
 if(declaredStageCount(groups)===0){
  const {candidates,roles,owned}=resolutionPlan(groups,observed);
  const matches=candidates.filter(group=>roles.every(role=>observed.get(sourceBindingKey(role))===owned.get(group)!.get(sourceBindingKey(role))!.sha256));
  if(matches.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
  return matches[0]!;
 }
 // With explicit later stages, ambiguity at an earlier stage is NOT fatal: the
 // later stage exists precisely to resolve it. Uniqueness is required only
 // after every applicable stage has been observed.
 const walk=stagedWalk(groups,observed);
 if(walk.roles.length)throw Error('Independent GitHub origin: staged secondary observation incomplete');
 // A value that WAS supplied for a key the surviving recipe declares must
 // equal that recipe's own mandatory original. Without this, a stale future
 // value (for example a later SDK's wrapper) would ride along unnoticed.
 for(const group of walk.survivors){
  for(const row of [...group.selectors,...(group.secondarySelectors??[]),...((group.secondarySelectorStages??[]).flat()),...group.sourceBindings]){
   const live=observed.get(sourceBindingKey(row));
   if(live!==undefined&&live!==row.sha256)throw Error('Independent GitHub origin: observed value differs from owned original');
  }
 }
 // Every declared stage role of the chosen recipe must also be actually
 // observed: a declared-but-unobserved owned role is never silently accepted.
 for(const group of walk.survivors){
  for(const row of [...(group.secondarySelectors??[]),...((group.secondarySelectorStages??[]).flat())]){
   if(!hasOwnObservation(observed,row))throw Error('Independent GitHub origin: staged secondary observation incomplete');
  }
 }
 if(walk.survivors.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return walk.survivors[0]!;
}
