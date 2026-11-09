import{test,expect}from'bun:test';
import{freezeGitHubSourceBindingGroups as freeze,secondaryGitHubSourceBindingSelectors as nextStaged,selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBindingGroup as Group}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const b=(p:string,q:string)=>({path:p,sha256:q});
function fixture():Group[]{const pr=b('producer','shared'),pt=b('ptrace','e85');return[
 {selectors:[pr,pt],secondarySelectors:[b('core','old')],sourceBindings:[b('core','old'),b('wrapper','w-old')]},
 {selectors:[pr,pt],secondarySelectors:[b('core','new')],secondarySelectorStages:[[b('wrapper','w-new')]],sourceBindings:[b('core','new'),b('wrapper','w-new')]},
] as Group[];}
test('freeze deep-freezes stages and preserves selection+refusal identically',()=>{
 const g=fixture(),plain=structuredClone(g),snap=JSON.stringify(g);freeze(g);
 expect(JSON.stringify(g)).toBe(snap);
 expect(()=>{(g[1]!.secondarySelectorStages![0] as any).push(b('evil','x'));}).toThrow();
 expect(()=>(g[1] as any).secondarySelectorStages=[]).toThrow();
 const o=new Map([['source:producer','shared'],['source:ptrace','e85']]);
 expect(nextStaged(g,o).map(r=>r.path)).toEqual(nextStaged(plain,o).map(r=>r.path));
 const sel=new Map([...o,['source:core','new'],['source:wrapper','w-new']]);
 expect(select(g,sel)).toBe(g[1]!);
 expect(select(plain,sel)).toBe(plain[1]!);
 const stale=new Map([...o,['source:core','old'],['source:wrapper','w-new']]);
 expect(()=>select(g,stale)).toThrow();expect(()=>select(plain,stale)).toThrow();
});
test('accessor-backed stage declarations keep live behaviour',()=>{
 const pr=b('producer','shared');
 // Live accessor: the declared role AND its mandatory original must stay
 // consistent, which is exactly what the existing mutable contract requires.
 let stage=[[b('wrapper','v1')]];
 let owns=b('wrapper','v1');
 const group:any={selectors:[pr],secondarySelectors:[]};
 Object.defineProperty(group,'secondarySelectorStages',{get:()=>stage,enumerable:true,configurable:true});
 Object.defineProperty(group,'sourceBindings',{get:()=>[owns],enumerable:true,configurable:true});
 const o=new Map([['source:producer','shared']]);
 expect(nextStaged([group],o).map(r=>r.path)).toEqual(['wrapper']);
 // A live change that keeps ownership consistent is observed.
 stage=[[b('wrapper','v2')]];owns=b('wrapper','v2');
 expect(nextStaged([group],o).map(r=>r.path)).toEqual(['wrapper']);
 // An inconsistent live change still refuses rather than selecting.
 stage=[[b('wrapper','v3')]];
 expect(()=>nextStaged([group],o)).toThrow(/conflicting owned secondary original/);
});
