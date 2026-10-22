import {test,expect} from 'bun:test';
import {freezeGitHubSourceBindingGroups as freeze,secondaryGitHubSourceBindingSelectors as roles,selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBindingGroup as Group} from '../../scripts/lib/independent-admission/github-source-binding-groups';
const row=(path:string,sha256:string)=>({path,sha256});
function fixture(){const primary=row('producer','shared');return [
 {selectors:[primary],secondarySelectors:[row('core','old')],sourceBindings:[row('core','old'),row('supervisor','old')]},
 {selectors:[primary],secondarySelectors:[row('core','new'),row('supervisor','new')],sourceBindings:[row('core','new'),row('supervisor','new')]},
] satisfies Group[];}
function observe(groups:readonly Group[],own:Group){const seen=new Map(own.selectors.map(value=>[key(value),value.sha256]));for(const needed of roles(groups,seen)){const original=[...own.selectors,...own.secondarySelectors??[],...own.sourceBindings].find(value=>key(value)===key(needed))!;seen.set(key(needed),original.sha256);}return seen;}
test('indexed declarations preserve every primary/secondary selection and refusal, never cache observed success',()=>{
 const indexed=fixture(),plain=structuredClone(indexed);const snapshot=JSON.stringify(indexed);freeze(indexed);expect(JSON.stringify(indexed)).toBe(snapshot);
 for(let repeat=0;repeat<3;repeat++)for(let index=0;index<indexed.length;index++){
  const seen=observe(indexed,indexed[index]!);expect(roles(indexed,seen)).toEqual(roles(plain,seen));expect(select(indexed,seen)).toBe(indexed[index]);expect(select(plain,seen)).toBe(plain[index]);
  for(const needed of roles(indexed,seen))for(const mode of ['missing','mixed']){const changed=new Map(seen);if(mode==='missing')changed.delete(key(needed));else changed.set(key(needed),'unreviewed');expect(()=>select(indexed,changed)).toThrow();expect(()=>select(plain,changed)).toThrow();}
 }
});
test('returned role arrays cannot poison a later indexed request',()=>{
 const groups=fixture();freeze(groups);const seen=observe(groups,groups[0]!);const first=roles(groups,seen) as any[];first.length=0;first.push(row('not-declared','fake'));expect(roles(groups,seen).map(value=>value.path)).toEqual(['core','supervisor']);expect(select(groups,seen)).toBe(groups[0]);
 expect(()=>{groups[0]!.sourceBindings[0]!.sha256='changed';}).toThrow();expect(()=>groups.push(groups[0]!)).toThrow();
});
test('mutable or accessor-backed declarations retain live behavior',()=>{
 const groups=fixture();const seen=observe(groups,groups[0]!);expect(select(groups,seen)).toBe(groups[0]);groups[0]!.selectors[0]!.sha256='changed';expect(()=>select(groups,seen)).toThrow();
 let name='before';const boxed:Group[]=[{selectors:[{path:{toString:()=>name},sha256:'shared'} as any],sourceBindings:[]}];freeze(boxed);expect(select(boxed,new Map([['source:before','shared']]))).toBe(boxed[0]);name='after';expect(select(boxed,new Map([['source:after','shared']]))).toBe(boxed[0]);
 let value='first';const dynamic={path:'producer',get sha256(){return value;}};const getters:Group[]=[{selectors:[dynamic],sourceBindings:[]}];freeze(getters);expect(select(getters,new Map([['source:producer','first']]))).toBe(getters[0]);value='second';expect(()=>select(getters,new Map([['source:producer','first']]))).toThrow();expect(select(getters,new Map([['source:producer','second']]))).toBe(getters[0]);
});
test('changing optional inherited fields cannot reuse stale compiled primary keys',()=>{
 const groups:Group[]=[{selectors:[row('producer','shared')],sourceBindings:[]}];freeze(groups);
 try{Object.defineProperty(Object.prototype,'ref',{value:'run-head',configurable:true});expect(select(groups,new Map([['run-head:producer','shared']]))).toBe(groups[0]);expect(()=>select(groups,new Map([['source:producer','shared']]))).toThrow();}
 finally{delete (Object.prototype as any).ref;}
 expect(select(groups,new Map([['source:producer','shared']]))).toBe(groups[0]);
});
test('partition eviction preserves overlapping primaries and duplicate-group ambiguity',()=>{
 const groups:Group[]=Array.from({length:3},(_,index)=>({selectors:[row('producer-'+index,'yes')],secondarySelectors:[row('core',String(index))],sourceBindings:[row('core',String(index))]}));freeze(groups);
 for(let repeat=0;repeat<3;repeat++)for(let bits=1;bits<8;bits++){const seen=new Map<string,string>();for(let index=0;index<3;index++)if(bits&(1<<index))seen.set('source:producer-'+index,'yes');const selected=[0,1,2].find(index=>bits&(1<<index))!;seen.set('source:core',String(selected));expect(select(groups,seen)).toBe(groups[selected]);seen.delete('source:core');expect(()=>select(groups,seen)).toThrow();}
 const duplicate=[groups[0]!,groups[0]!];freeze(duplicate);expect(()=>select(duplicate,new Map([['source:producer-0','yes'],['source:core','0']]))).toThrow();
});
test('missing or conflicting ownership still refuses before any secondary acquisition',()=>{
 for(const mode of ['missing','conflict']){const groups=fixture();groups[0]!.sourceBindings=mode==='missing'?[row('core','old')]:[...groups[0]!.sourceBindings,row('supervisor','conflict')];freeze(groups);let gets=0;expect(()=>{for(const _ of roles(groups,new Map([['source:producer','shared']])))gets++;}).toThrow();expect(gets).toBe(0);}
});
