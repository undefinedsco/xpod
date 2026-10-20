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
export function secondaryGitHubSourceBindingSelectors(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBinding[]{
 return sharedSecondary(primaryCandidates(groups,observed)).roles;
}
/** Entire reviewed workflow/source recipes are selected atomically. Missing
 * observed secondary originals never fall back to declaration-only values. */
export function selectGitHubSourceBindingGroup(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):GitHubSourceBindingGroup {
 const candidates=primaryCandidates(groups,observed),{roles,owned}=sharedSecondary(candidates);
 const matches=candidates.filter(group=>roles.every(role=>observed.get(sourceBindingKey(role))===owned.get(group)!.get(sourceBindingKey(role))!.sha256));
 if(matches.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return matches[0]!;
}
