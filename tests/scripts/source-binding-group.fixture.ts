import {secondaryGitHubSourceBindingSelectors,sourceBindingKey,type GitHubSourceBinding,type GitHubSourceBindingGroup} from '../../scripts/lib/independent-admission/github-source-binding-groups';
/** Model the real primary -> requested role -> own mandatory original flow.
 *
 * Bounded: it keeps asking the SAME planner for the roles that are still
 * MISSING and stops when nothing is outstanding. This supports legacy
 * single-stage recipes and staged recipes alike. Every value written comes from
 * the selected recipe's OWN mandatory original - a declaration is never treated
 * as an observation, and a missing role throws instead of being invented. */
export function completeObserved(groups:readonly GitHubSourceBindingGroup[],group:GitHubSourceBindingGroup):Map<string,string>{
 const observed=new Map(group.selectors.map(row=>[sourceBindingKey(row),row.sha256]));
 const declared=new Set(groups.flatMap(g=>[...g.selectors,...(g.secondarySelectors??[]),...(g.secondarySelectorStages??[]).flat(),...g.sourceBindings].map(row=>sourceBindingKey(row)))).size;
 const maximumRounds=declared+1;
 for(let round=0;round<maximumRounds;round++){
  const missing=secondaryGitHubSourceBindingSelectors(groups,observed)
   .filter((role:GitHubSourceBinding)=>!observed.has(sourceBindingKey(role)));
  if(!missing.length)break;
  for(const role of missing){
   const own=[...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings]
    .filter((row:GitHubSourceBinding)=>sourceBindingKey(row)===sourceBindingKey(role));
   if(!own.length||new Set(own.map((row:GitHubSourceBinding)=>row.sha256)).size!==1)throw Error('Fixture missing consistent own mandatory original');
   observed.set(sourceBindingKey(role),own[0]!.sha256);
  }
 }
 return observed;
}

/** Actual acquired secondary originals, including roles promoted by another
 * surviving recipe. Negative cases can remove every observed role without
 * assuming that acquisition ends after one stage. */
export function observedSecondaryBindings(group:GitHubSourceBindingGroup,observed:ReadonlyMap<string,string>):readonly GitHubSourceBinding[]{
 const primary=new Set(group.selectors.map(sourceBindingKey));
 const originals=[...group.selectors,...(group.secondarySelectors??[]),...(group.secondarySelectorStages??[]).flat(),...group.sourceBindings];
 return [...observed.keys()].filter(key=>!primary.has(key)).map(key=>{
  const own=originals.filter(row=>sourceBindingKey(row)===key);
  if(!own.length||new Set(own.map(row=>row.sha256)).size!==1||own[0]!.sha256!==observed.get(key))throw Error('Fixture missing consistent observed original');
  return own[0]!;
 });
}
