import {it,expect} from 'vitest';
import {selectSdkControllerHelperGroup as select} from '../../scripts/lib/independent-admission/sdk-controller-helper-groups';
const before=[['scanner.py','a'.repeat(64)],['zip.py','b'.repeat(64)],['binary.py','c'.repeat(64)]] as const;
const after=[['scanner.py','a'.repeat(64)],['zip.py','d'.repeat(64)],['binary.py','e'.repeat(64)]] as const;
it('selects one complete reviewed helper tuple and preserves the historical tuple',()=>{for(const group of [before,after])expect(select([before,after],new Map(group))).toBe(group);});
it('rejects independent helper-version unions, missing, extra and unknown bytes',()=>{
 for(const observed of [new Map([before[0],before[1],after[2]]),new Map([before[0],after[1],before[2]]),new Map(before.slice(0,2)),new Map([...after,['extra.py','f'.repeat(64)] as const]),new Map([before[0],before[1],['binary.py','f'.repeat(64)] as const])])expect(()=>select([before,after],observed)).toThrow('complete helper group');
 expect(()=>select([before,before],new Map(before))).toThrow();expect(()=>select([[before[0],before[0]]],new Map([before[0]]))).toThrow();
});
