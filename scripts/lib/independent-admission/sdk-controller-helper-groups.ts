/** Pure exact controller-byte tuple selection; no original capability issuer. */
export function selectSdkControllerHelperGroup(groups:readonly (readonly (readonly [string,string])[])[],observed:ReadonlyMap<string,string>):readonly (readonly [string,string])[]{
 if(!groups.length||groups.length>13||observed.size>32)throw Error('SDK controller complete helper group differs');
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
 if(!groups.length||groups.length>13||!requiredNames.length||requiredNames.length>32||new Set(requiredNames).size!==requiredNames.length||observed.size!==requiredNames.length||!requiredNames.every(name=>observed.has(name)))throw Error('SDK controller complete helper group differs');
 const matches=groups.filter(group=>group.length<=32&&new Set(group.map(([name])=>name)).size===group.length&&requiredNames.every(name=>group.some(([role,sha])=>role===name&&observed.get(name)===sha)));
 if(matches.length!==1)throw Error('SDK controller complete helper group differs');
 return matches[0]!;
}
