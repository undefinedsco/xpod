import{test,expect}from'bun:test';
import{secondaryGitHubSourceBindingSelectors as roles,selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBindingGroup as Group}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const binding=(path:string,sha256:string)=>({path,sha256});
function fixture(){const primary=binding('producer','shared'),old:Group={selectors:[primary],secondarySelectors:[binding('core','old')],sourceBindings:[binding('core','old'),binding('supervisor','old')]},next:Group={selectors:[primary],secondarySelectors:[binding('core','new'),binding('supervisor','new')],sourceBindings:[binding('core','new'),binding('supervisor','new')]};return{old,next,primary};}
test('three-stage real own originals promote an already mandatory role without mutating either whole group',()=>{
 const{old,next,primary}=fixture(),groups=[old,next],snap=JSON.stringify(groups);
 for(const own of groups){const observed=new Map([[key(primary),primary.sha256]]),requested=roles(groups,observed);expect(requested.map(r=>r.path)).toEqual(['core','supervisor']);for(const role of requested){const actual=own.sourceBindings.find(row=>key(row)===key(role))!;observed.set(key(role),actual.sha256);}expect(select(groups,observed)).toBe(own);const missing=new Map(observed);missing.delete('source:supervisor');expect(()=>select(groups,missing)).toThrow();const mixed=new Map(observed);mixed.set('source:supervisor',own===old?'new':'old');expect(()=>select(groups,mixed)).toThrow();}
 expect(JSON.stringify(groups)).toBe(snap);
});
test('a missing or conflicting own mandatory role refuses before any acquisition and other primaries never fetch it',()=>{
 const{old,next,primary}=fixture();for(const bad of[{...old,sourceBindings:[binding('core','old')]},{...old,sourceBindings:[...old.sourceBindings,binding('supervisor','conflict')]}]){let gets=0;expect(()=>{for(const _ of roles([bad,next],new Map([[key(primary),primary.sha256]])))gets++;}).toThrow();expect(gets).toBe(0);}
 const separate:Group={selectors:[binding('producer','historical')],secondarySelectors:[],sourceBindings:[]};expect(roles([separate,next],new Map([['source:producer','historical']]))).toEqual([]);expect(select([separate,next],new Map([['source:producer','historical']]))).toBe(separate);
 const repeated={...old,sourceBindings:[...old.sourceBindings,binding('supervisor','old')]};expect(select([repeated,next],new Map([['source:producer','shared'],['source:core','old'],['source:supervisor','old']]))).toBe(repeated);
});
