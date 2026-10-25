import{test,expect}from'bun:test';
import{requiredSdkControllerHelperGroup as plan,selectSdkControllerHelperGroup as select}from'../../scripts/lib/independent-admission/sdk-controller-helper-groups';
const old=[['model.py','a'],['shared.py','b']]as const,newer=[['model.py','c'],['shared.py','b'],['new.py','d']]as const,names=['model.py','shared.py'];
test('complete common tuple selects only its declared additional originals; old never asks for future role',()=>{
 expect(plan([old,newer],names,new Map(old))).toBe(old);expect(plan([old,newer],names,new Map(newer.slice(0,2)))).toBe(newer);expect(()=>select([old,newer],new Map(newer.slice(0,2)))).toThrow();expect(select([old,newer],new Map(newer))).toBe(newer);
});
test('missing mixed unknown roles and ambiguous common tuple refuse before any additional read',()=>{
 for(const values of [new Map([old[0]]),new Map([old[0],['shared.py','x']]),new Map([old[0],old[1],['extra.py','z']])])expect(()=>plan([old,newer],names,values)).toThrow();
 expect(()=>plan([old,[...old,['new.py','d']]],names,new Map(old))).toThrow();expect(()=>plan([[...old,old[0]]],names,new Map(old))).toThrow();
});
test('sixteen declared complete groups only; observed original bound remains thirty two',()=>{
 const groups=Array.from({length:16},(_,i)=>[['model.py',String(i)],['shared.py','b']]as const);expect(select(groups,new Map(groups[15]!))).toBe(groups[15]);expect(()=>select([...groups,groups[15]!],new Map(groups[15]!))).toThrow();expect(()=>plan([...groups,groups[15]!],names,new Map(groups[15]!))).toThrow();expect(()=>select([old],new Map(Array.from({length:33},(_,i)=>[String(i),'a'])))).toThrow();
});

test('thirty-four registered recipes fit capacity; a thirty-fifth rejects before extra reads',()=>{
 // The declared VERSION catalogue grew to the exact new maximum 34 because the
 // real current cohort needed a 34th tuple. The observed PER-TUPLE role bound
 // stays 32 (see the previous case); only the catalogue length changed.
 const groups=Array.from({length:34},(_,i)=>[['model.py',String(i)],['shared.py','b']]as const);
 const observed=new Map(groups[30]!);expect(plan(groups,names,observed)).toBe(groups[30]);expect(select(groups,observed)).toBe(groups[30]);
 const overflow=[...groups,[['model.py','34'],['shared.py','b']]as const];expect(()=>plan(overflow,names,observed)).toThrow();expect(()=>select(overflow,observed)).toThrow();
});
