/** Pure exact controller-byte tuple selection; no original capability issuer. */
export function selectSdkControllerHelperGroup(groups:readonly (readonly (readonly [string,string])[])[],observed:ReadonlyMap<string,string>):readonly (readonly [string,string])[]{
 if(!groups.length||groups.length>8||observed.size>32)throw Error('SDK controller complete helper group differs');
 const matches=groups.filter(group=>group.length===observed.size&&group.length===new Set(group.map(([name])=>name)).size&&group.every(([name,sha])=>observed.get(name)===sha));
 if(matches.length!==1)throw Error('SDK controller complete helper group differs');
 return matches[0]!;
}
