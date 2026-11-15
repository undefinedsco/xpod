import{test,expect}from'bun:test';
import{completeObserved}from'./source-binding-group.fixture';
import{selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBindingGroup as Group}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const SHA=(f:string)=>f.repeat(64).slice(0,64);
const b=(p:string,q:string)=>({path:p,sha256:SHA(q)});
test('fixture completes a staged recipe from its own originals',()=>{
 const pr=b('workflow','aa');
 const old:Group={selectors:[pr],secondarySelectors:[b('core','01')],sourceBindings:[pr,b('core','01'),b('wrapper','03')]};
 const next:Group={selectors:[pr],secondarySelectors:[b('core','01')],secondarySelectorStages:[[b('wrapper','02')]],sourceBindings:[pr,b('core','01'),b('wrapper','02')]};
 for(const own of [old,next]){
  const seen=completeObserved([old,next],own);
  expect(select([old,next],seen)).toBe(own);
  for(const v of seen.values())expect(/^[a-f0-9]{64}$/u.test(v)).toBe(true);
 }
});
