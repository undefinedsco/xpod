/** Pure exact controller-byte tuple selection; no original capability issuer. */
// 32 historical whole tuples + 1 appended final-slice tuple (fetch reached the
// previous declared 32). The observed PER-TUPLE role bound stays 32; only the
// declared VERSION count grows to the exact new maximum.
const MAXIMUM_DECLARED_HELPER_GROUPS = 33;
const MAXIMUM_OBSERVED_HELPERS = 32;
export function selectSdkControllerHelperGroup(groups:readonly (readonly (readonly [string,string])[])[],observed:ReadonlyMap<string,string>):readonly (readonly [string,string])[]{
 if(!groups.length||groups.length>MAXIMUM_DECLARED_HELPER_GROUPS||observed.size>MAXIMUM_OBSERVED_HELPERS)throw Error('SDK controller complete helper group differs');
 const matches=groups.filter(group=>group.length===observed.size&&group.length===new Set(group.map(([name])=>name)).size&&group.every(([name,sha])=>observed.get(name)===sha));
 if(matches.length!==1)throw Error('SDK controller complete helper group differs');
 return matches[0]!;
}

/** Resolve declared additional imports only after the complete common tuple
 * uniquely identifies a reviewed group. The final full tuple is still checked
 * by selectSdkControllerHelperGroup after every additional original is read.
 * Old groups request no future import; this pure plan issues no authority.
 */
export function requiredSdkControllerHelperGroup(groups:readonly (readonly (readonly [string,string])[])[],requiredNames:readonly string[],observed:ReadonlyMap<string,string>):readonly (readonly [string,string])[]{
 if(!groups.length||groups.length>MAXIMUM_DECLARED_HELPER_GROUPS||!requiredNames.length||requiredNames.length>MAXIMUM_OBSERVED_HELPERS||new Set(requiredNames).size!==requiredNames.length||observed.size!==requiredNames.length||!requiredNames.every(name=>observed.has(name)))throw Error('SDK controller complete helper group differs');
 const matches=groups.filter(group=>group.length<=MAXIMUM_OBSERVED_HELPERS&&new Set(group.map(([name])=>name)).size===group.length&&requiredNames.every(name=>group.some(([role,sha])=>role===name&&observed.get(name)===sha)));
 if(matches.length!==1)throw Error('SDK controller complete helper group differs');
 return matches[0]!;
}
