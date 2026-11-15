/** Test-only checked access: the repository's portable bun:test shim omits mock. */
import * as testRuntime from 'bun:test';
export function mockModule(name:string,factory:()=>object):void{
 const runtime=Reflect.get(testRuntime,'mock');
 if(!runtime||typeof runtime.module!=='function')throw Error('Actual Bun module mock API required');
 runtime.module(name,factory);
}
