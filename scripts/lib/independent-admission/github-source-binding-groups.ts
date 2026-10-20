import type {CandidateServiceRelationshipContract} from './qlever-sdk-service-relationship';
import type {QleverSdkOuterExecutorContract} from './qlever-sdk-outer-authority';
export interface GitHubSourceBinding {readonly path:string;readonly sha256:string;readonly ref?:'run-head';readonly reviewedSha256?:readonly string[]}
export interface GitHubSourceBindingGroup {readonly candidateServiceRelationship?:CandidateServiceRelationshipContract;readonly outerExecutor?:QleverSdkOuterExecutorContract;readonly selectors:readonly GitHubSourceBinding[];readonly secondarySelectors?:readonly GitHubSourceBinding[];readonly sourceBindings:readonly GitHubSourceBinding[]}
export const sourceBindingKey=(binding:GitHubSourceBinding):string=>(binding.ref??'source')+':'+binding.path;
/** Secondary originals are requested only after the complete historical shared
 * tuple matches. Every remaining candidate must possess these exact roles;
 * old trees lacking newer helpers are never probed or granted a fallback. */
export function secondaryGitHubSourceBindingSelectors(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):readonly GitHubSourceBinding[]{
 const candidates=groups.filter(group=>group.selectors.every(binding=>observed.get(sourceBindingKey(binding))===binding.sha256));
 if(!candidates.length)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 const selectors=new Map(candidates.flatMap(group=>(group.secondarySelectors??[]).map(binding=>[sourceBindingKey(binding),binding] as const)));
 if(candidates.some(group=>selectors.size!==(group.secondarySelectors??[]).length||(group.secondarySelectors??[]).some(binding=>!selectors.has(sourceBindingKey(binding)))))throw Error('Independent GitHub origin: incomplete shared secondary selector roles');
 return [...selectors.values()];
}
/** Entire reviewed workflow/source recipes are selected atomically. A mixture
 * of individually reviewed file versions is never a reviewed execution tree. */
export function selectGitHubSourceBindingGroup(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):GitHubSourceBindingGroup {
 const matches=groups.filter(group=>[...group.selectors,...(group.secondarySelectors??[])].every(binding=>observed.get(sourceBindingKey(binding))===binding.sha256));
 if(matches.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return matches[0]!;
}
