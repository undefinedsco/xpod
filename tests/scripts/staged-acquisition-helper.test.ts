import{test,expect}from'bun:test';
import{acquireOwnedSecondaryBindings as acquire,selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBinding as Binding,type GitHubSourceBindingGroup as Group}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const b=(path:string,sha256:string)=>({path,sha256});

/** THE REAL SHAPE from root's counterexample: ancient never owned wrapper;
 * SDK79 and SDK80 share BOTH the primary and the stage-0 core original. */
function real(){
 const primary=owned('workflow','aa');
 const ancient:Group={selectors:[primary],secondarySelectors:[owned('core','03')],sourceBindings:[owned('core','03')]};
 const old:Group={selectors:[primary],secondarySelectors:[owned('core','01')],sourceBindings:[owned('core','01'),owned('wrapper','03')]};
 const next:Group={selectors:[primary],secondarySelectors:[owned('core','01')],secondarySelectorStages:[[owned('wrapper','02')]],sourceBindings:[owned('core','01'),owned('wrapper','02')]};
 return{ancient,old,next,primary,groups:[ancient,old,next] as Group[]};
}
const SHA=(fill:string)=>fill.repeat(64).slice(0,64);
/** Declaration-side sha values must be the SAME 64-hex space the helper
 * validates, so an owned original and its observation compare equal. */
const owned=(path:string,fill:string)=>b(path,SHA(fill));

function readerFor(values:Record<string,string>,log:string[]){
 return async(role:Binding)=>{log.push(role.path);return SHA(values[role.path]??'0');};
}

test('A: a LEGACY group with nonempty secondarySelectors succeeds after ONE fetch',async()=>{
 // This is the release blocker: the old loop refetched/re-failed on this shape.
 const primary=owned('workflow','aa');
 const core=owned('core','01'),helper=owned('helper','02');
 const legacy:Group={selectors:[primary],secondarySelectors:[core,helper],sourceBindings:[primary,core,helper]};
 const observed=new Map<string,string>([[key(primary),SHA('aa')]]);
 const log:string[]=[];
 const group=await acquire([legacy],observed,readerFor({core:'01',helper:'02'},log),()=>{});
 expect(log).toEqual(['core','helper']);        // exactly one fetch each
 expect(group).toBe(legacy);
});

test('A2: a legacy group whose roles are ALREADY observed never refetches',async()=>{
 const primary=owned('workflow','aa');
 const core=owned('core','01');
 const legacy:Group={selectors:[primary],secondarySelectors:[core],sourceBindings:[primary,core]};
 const observed=new Map<string,string>([[key(primary),SHA('aa')],[key(core),SHA('01')]]);
 const log:string[]=[];
 const group=await acquire([legacy],observed,readerFor({},log),()=>{});
 expect(log).toEqual([]);                       // no GET at all
 expect(group).toBe(legacy);
});

test('B: same-core SDK79/SDK80 resolves in exactly 2 rounds of acquisition',async()=>{
 const{groups,next}=real();
 const observed=new Map<string,string>([[key(groups[0]!.selectors[0]!),SHA('aa')]]);
 const log:string[]=[];
 const group=await acquire(groups,observed,readerFor({core:'01',wrapper:'02'},log),()=>{});
 expect(log).toEqual(['core','wrapper']);       // one round per stage
 expect(group).toBe(next);
});

test('ancient is excluded before wrapper is ever requested',async()=>{
 const{groups,ancient}=real();
 const observed=new Map<string,string>([[key(groups[0]!.selectors[0]!),SHA('aa')]]);
 const log:string[]=[];
 observed.set('source:core',SHA('03'));         // ancient's own core value
 const group=await acquire(groups,observed,async r=>{log.push(r.path);return SHA('09');},()=>{});
 expect(log).toEqual([]);                       // nothing left to fetch
 expect(group).toBe(ancient);
});

test('C: every candidate must own the role BEFORE any GET, even nonparticipants',async()=>{
 const primary=owned('workflow','aa');
 const core=owned('core','01');
 // `bystander` takes no part in the stage and owns no wrapper original.
 const owning:Group={selectors:[primary],secondarySelectors:[core],secondarySelectorStages:[[owned('wrapper','02')]],sourceBindings:[primary,core,owned('wrapper','02')]};
 const bystander:Group={selectors:[primary],secondarySelectors:[core],sourceBindings:[primary,core]};
 const observed=new Map<string,string>([[key(primary),SHA('aa')],[key(core),SHA('01')]]);
 const log:string[]=[];
 await expect(acquire([owning,bystander],observed,async r=>{log.push(r.path);return SHA('02');},()=>{}))
  .rejects.toThrow(/missing owned secondary original/);
 expect(log).toEqual([]);                       // zero reads before the refusal
});

test('legacy stage0 zero-read refusal when a survivor owns no requested role',async()=>{
 const primary=owned('workflow','aa');
 const a1:Group={selectors:[primary],secondarySelectors:[owned('core','01')],sourceBindings:[primary,owned('core','01')]};
 // a2 declares `core` but its own mandatory original carries a DIFFERENT value,
 // so it genuinely does not own the requested role consistently.
 const a2:Group={selectors:[primary],secondarySelectors:[owned('core','01')],sourceBindings:[primary,owned('core','09')]};
 const observed=new Map<string,string>([[key(primary),SHA('aa')]]);
 const log:string[]=[];
 await expect(acquire([a1,a2],observed,async r=>{log.push(r.path);return SHA('01');},()=>{}))
  .rejects.toThrow(/missing|conflicting owned secondary original/);
 expect(log).toEqual([]);
});

test('unknown, missing and mixed observations fail closed',async()=>{
 const{groups,primary}=real();
 const unknown=new Map<string,string>([[key(primary),SHA('aa')],['source:core',SHA('ff')]]);
 await expect(acquire(groups,unknown,async()=>SHA('01'),()=>{})).rejects.toThrow();
 const mixed=new Map<string,string>([[key(primary),SHA('aa')],['source:core',SHA('01')],['source:wrapper',SHA('ff')]]);
 await expect(acquire(groups,mixed,async()=>SHA('02'),()=>{})).rejects.toThrow();
});

test('a shared absolute deadline is never renewed between rounds',async()=>{
 const{groups,primary}=real();
 const observed=new Map<string,string>([[key(primary),SHA('aa')]]);
 let now=0,rounds=0;
 const checkDeadline=()=>{if(now>=1)throw Error('deadline exceeded');};
 await expect(acquire(groups,observed,async role=>{rounds+=1;now=5;return SHA('02');},checkDeadline))
  .rejects.toThrow('deadline exceeded');
 expect(rounds<=1).toBe(true);                  // the budget did not reset
});

test('source and run-head namespaces are fetched under distinct keys',async()=>{
 const primary=owned('workflow','aa');
 const head={path:'wrapper',sha256:SHA('02'),ref:'run-head' as const};
 const group:Group={selectors:[primary],secondarySelectors:[],secondarySelectorStages:[[head]],sourceBindings:[primary,head]};
 const observed=new Map<string,string>([[key(primary),SHA('aa')]]);
 const log:string[]=[];
 const chosen=await acquire([group],observed,async r=>{log.push(key(r));return SHA('02');},()=>{});
 expect(log).toEqual(['run-head:wrapper']);
 expect(observed.has('source:wrapper')).toBe(false);
 expect(chosen).toBe(group);
});
