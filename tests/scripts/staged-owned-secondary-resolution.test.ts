import{test,expect}from'bun:test';
import{secondaryGitHubSourceBindingSelectors as plan,selectGitHubSourceBindingGroup as select,sourceBindingKey as key,type GitHubSourceBindingGroup as Group}from'../../scripts/lib/independent-admission/github-source-binding-groups';
const b=(path:string,sha256:string)=>({path,sha256});

/** ROOT'S REAL COUNTEREXAMPLE (staged-owned-secondary-root-counterexample).
 *
 * `ancient` never owned `wrapper` at all. `old` (SDK79) and `next` (SDK80) share
 * the SAME primary AND the SAME stage-0 `core` original; only the later `wrapper`
 * differs. Stage 0 therefore cannot disambiguate them, and an implementation that
 * demands stage-0 uniqueness can never resolve the very ambiguity stages exist
 * for.
 */
function real(){
 const primary=b('workflow','same');
 const ancient:Group={selectors:[primary],secondarySelectors:[b('core','ancient')],sourceBindings:[b('core','ancient')]};
 const old:Group={selectors:[primary],secondarySelectors:[b('core','same-current')],sourceBindings:[b('core','same-current'),b('wrapper','old')]};
 const next:Group={selectors:[primary],secondarySelectors:[b('core','same-current')],secondarySelectorStages:[[b('wrapper','new')]],sourceBindings:[b('core','same-current'),b('wrapper','new')]};
 return{ancient,old,next,primary,groups:[ancient,old,next] as Group[]};
}

test('stage 0 cannot disambiguate, so stage 1 must be offered and resolve',()=>{
 const{old,next,primary,groups}=real();
 const seen=new Map([[key(primary),'same']]);
 // Stage 0 requests only core, and core is IDENTICAL for old and next.
 expect(plan(groups,seen).map(row=>row.path)).toEqual(['core']);
 expect(()=>select(groups,seen)).toThrow();
 seen.set('source:core','same-current');
 // Both survive stage 0; the later stage is now requested.
 expect(plan(groups,seen).map(row=>row.path)).toEqual(['wrapper']);
 expect(()=>select(groups,seen)).toThrow();
 // The wrapper value decides between the two otherwise identical candidates.
 seen.set('source:wrapper','new');
 expect(select(groups,seen)).toBe(next);
 const other=new Map([[key(primary),'same'],['source:core','same-current'],['source:wrapper','old']]);
 expect(select(groups,other)).toBe(old);
});

test('ancient is narrowed by stage 0 and never asked for wrapper',()=>{
 const{groups,primary}=real();
 const seen=new Map([[key(primary),'same']]);
 expect(plan(groups,seen).map(row=>row.path)).toEqual(['core']);
 seen.set('source:core','ancient');
 // ancient has no later stage, so nothing more is requested for it.
 expect(plan(groups,seen)).toEqual([]);
 expect(select(groups,seen)).toBe(groups[0]!);
});

test('a pre-filled future value cannot prune before stage 0 is proven',()=>{
 const{groups,primary,next}=real();
 const seen=new Map([[key(primary),'same'],['source:wrapper','new']]);
 // core is still unresolved: wrapper must not decide anything yet.
 expect(plan(groups,seen).map(row=>row.path)).toEqual(['core']);
 expect(()=>select(groups,seen)).toThrow();
 seen.set('source:core','same-current');
 // The future value was already supplied, so the planner has nothing left to
 // request; the selector must still use it only now that stage 0 is proven.
 expect(plan(groups,seen)).toEqual([]);
 expect(select(groups,seen)).toBe(next);
});

test('unknown, missing and mixed values fail closed',()=>{
 const{groups,primary}=real();
 const unknown=new Map([[key(primary),'same'],['source:core','not-reviewed'],['source:wrapper','new']]);
 expect(()=>select(groups,unknown)).toThrow();
 const missing=new Map([[key(primary),'same']]);
 expect(()=>select(groups,missing)).toThrow();
 const mixed=new Map([[key(primary),'same'],['source:core','same-current'],['source:wrapper','not-reviewed']]);
 expect(()=>select(groups,mixed)).toThrow();
});

test('naming a future role without a mandatory original cannot self-certify',()=>{
 const{next,primary}=real();
 // Claims stage 1 wrapper but never carries the original outside that stage.
 const liar:Group={...next,sourceBindings:[b('core','same-current')]};
 const seen=new Map([[key(primary),'same'],['source:core','same-current']]);
 expect(()=>plan([liar],seen)).toThrow(/missing|conflicting owned secondary original/);
 const taken=new Map([...seen,['source:wrapper','new']]);
 expect(()=>select([liar],taken)).toThrow();
});

test('a stage role conflicting with the mandatory original refuses',()=>{
 const{next,primary}=real();
 const conflicting:Group={...next,sourceBindings:[b('core','same-current'),b('wrapper','different')]};
 const seen=new Map([[key(primary),'same'],['source:core','same-current']]);
 expect(()=>plan([conflicting],seen)).toThrow(/conflicting owned secondary original/);
});

test('source and run-head keys stay separate across stages',()=>{
 const primary=b('workflow','same');
 const head={path:'wrapper',sha256:'w-head',ref:'run-head' as const};
 // Declaring a run-head role WITHOUT carrying it as a mandatory original is
 // exactly the self-certification the ownership rule forbids.
 const unowned:Group={selectors:[primary],secondarySelectors:[],secondarySelectorStages:[[head]],sourceBindings:[primary]};
 expect(()=>plan([unowned],new Map([[key(primary),'same']]))).toThrow(/missing owned secondary original/);
 // A legitimate run-head role is also carried as a real mandatory original.
 const group:Group={selectors:[primary],secondarySelectors:[],secondarySelectorStages:[[head]],sourceBindings:[primary,head]};
 const seen=new Map([[key(primary),'same']]);
 expect(plan([group],seen).map(row=>key(row))).toEqual(['run-head:wrapper']);
 const sourceOnly=new Map(seen);
 sourceOnly.set('source:wrapper','w-head');
 expect(()=>select([group],sourceOnly)).toThrow();
 const headOnly=new Map(seen);
 headOnly.set('run-head:wrapper','w-head');
 expect(select([group],headOnly)).toBe(group);
});

test('a single-candidate recipe still requires its own later stage to be observed',()=>{
 const primary=b('workflow','same');
 const lone:Group={selectors:[primary],secondarySelectors:[b('core','only')],secondarySelectorStages:[[b('wrapper','w')]],sourceBindings:[b('core','only'),b('wrapper','w')]};
 const seen=new Map([[key(primary),'same'],['source:core','only']]);
 expect(plan([lone],seen).map(row=>row.path)).toEqual(['wrapper']);
 expect(()=>select([lone],seen)).toThrow();
 seen.set('source:wrapper','w');
 expect(select([lone],seen)).toBe(lone);
});
