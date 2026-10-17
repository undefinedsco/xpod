export interface GitHubSourceBinding {readonly path:string;readonly sha256:string;readonly ref?:'run-head';readonly reviewedSha256?:readonly string[]}
export interface GitHubSourceBindingGroup {readonly selectors:readonly GitHubSourceBinding[];readonly sourceBindings:readonly GitHubSourceBinding[]}
export const sourceBindingKey=(binding:GitHubSourceBinding):string=>(binding.ref??'source')+':'+binding.path;
/** Entire reviewed workflow/source recipes are selected atomically. A mixture
 * of individually reviewed file versions is never a reviewed execution tree. */
export function selectGitHubSourceBindingGroup(groups:readonly GitHubSourceBindingGroup[],observed:ReadonlyMap<string,string>):GitHubSourceBindingGroup {
 const matches=groups.filter(group=>group.selectors.every(binding=>observed.get(sourceBindingKey(binding))===binding.sha256));
 if(matches.length!==1)throw Error('Independent GitHub origin: exact workflow/source group not reviewed');
 return matches[0]!;
}
