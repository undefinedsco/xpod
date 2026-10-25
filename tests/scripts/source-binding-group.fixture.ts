import {secondaryGitHubSourceBindingSelectors,sourceBindingKey,type GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
/** Model the real primary -> requested secondary -> own mandatory original flow.
 * Never fill an old recipe with the current recipe's SHA or a future path. */
export function completeObserved(groups:readonly GitHubSourceBindingGroup[],group:GitHubSourceBindingGroup):Map<string,string>{
 const observed=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 for(const role of secondaryGitHubSourceBindingSelectors(groups,observed)){
  const own=[...group.selectors,...group.secondarySelectors??[],...group.sourceBindings].filter(row=>sourceBindingKey(row)===sourceBindingKey(role));
  if(!own.length||new Set(own.map(row=>row.sha256)).size!==1)throw Error('Fixture missing consistent own mandatory original');
  observed.set(sourceBindingKey(role),own[0]!.sha256);
 }
 return observed;
}
