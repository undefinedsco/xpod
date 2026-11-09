import {test,expect} from 'bun:test';
import {createRequire} from 'node:module';
import {nativeArchiveInspectionTimeout} from '../../scripts/lib/independent-admission/native-archive-observation-budget';
import limits from '../../scripts/lib/module-artifact-limits.json';
const {inspectArtifact}=createRequire(import.meta.url)('../../scripts/lib/product-artifact-command.cjs');
test('optional native observation budget narrows the default scanner and cannot raise it',()=>{
 expect(nativeArchiveInspectionTimeout()).toBe(limits.timeoutMs);
 expect(nativeArchiveInspectionTimeout({check(){},remainingMs:()=>limits.timeoutMs*2})).toBe(limits.timeoutMs);
 expect(nativeArchiveInspectionTimeout({check(){},remainingMs:()=>1.9})).toBe(1);
});
test('expired or invalid remaining budget rejects before scanner spawn',()=>{
 let calls=0;
 const execute=()=>{calls++;return {status:0,stdout:Buffer.from('{}'),stderr:Buffer.alloc(0)};};
 for(const remaining of [0,-1,0.5,NaN,Infinity])expect(()=>inspectArtifact(['-c','pass'],{timeout:nativeArchiveInspectionTimeout({check(){},remainingMs:()=>remaining}),maxBuffer:1024},execute)).toThrow('deadline expired');
 expect(()=>nativeArchiveInspectionTimeout({check(){throw Error('caller deadline');},remainingMs:()=>100})).toThrow('caller deadline');
 expect(calls).toBe(0);
});
test('near deadline limits the actual existing Python scanner child, and no second default window is granted',()=>{
 const budget={check(){},remainingMs:()=>20};
 const result=inspectArtifact(['-c','import time;time.sleep(2)'],{timeout:nativeArchiveInspectionTimeout(budget),maxBuffer:1024});
 expect(result.error?.code).toBe('ETIMEDOUT');
 let remaining=50;
 const shared={check(){},remainingMs:()=>remaining};
 expect(nativeArchiveInspectionTimeout(shared)).toBe(50);
 remaining=0;
 expect(()=>nativeArchiveInspectionTimeout(shared)).toThrow('deadline expired');
});
