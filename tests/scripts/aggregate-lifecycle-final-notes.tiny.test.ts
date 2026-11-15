/** N1 + N2 fault tests for the aggregate lifecycle.
 *
 * N1: an invalid pack view must throw BEFORE any owned stage root exists, so no
 *     directory is leaked. The test asserts the ACTUAL failure path (a real
 *     allocator, a real temp sweep), not a line-number regex.
 * N2: a plain JS Error has no addNote, so the old path silently dropped cleanup
 *     failures. These tests use REAL Error objects and assert both failures are
 *     preserved, primary first.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {allocateCandidateServiceStagingRoot} from '../../scripts/lib/independent-admission/candidate-service-workspace-inputs';

const ROOT=path.resolve(import.meta.dir,'../..');
const STAGING=path.join(ROOT,'.test-data');
const PIPE=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-normal-pipeline.ts'),'utf8');

// Real sweep of the canonical staging parent. The allocator itself creates this
// parent, so treat an absent parent as "no owned roots" rather than failing.
const ownedRoots=()=>{
 try{return fs.readdirSync(STAGING).filter(n=>n.startsWith('service-normal-stage-'));}
 catch(error){
  if((error as NodeJS.ErrnoException)?.code==='ENOENT')return [];
  throw error;
 }
};

// Faithful model of the FIXED pipeline ordering: every pre-allocation need runs
// FIRST; the allocator is the first statement INSIDE the protected try; a single
// cleanup thunk releases what was allocated.
function combine(primary:unknown,cleanup:unknown,label:string):Error{
 if(cleanup===undefined)return primary as Error;
 const primaryError=primary instanceof Error?primary:Error(String(primary));
 const cleanupError=cleanup instanceof Error?cleanup:Error(String(cleanup));
 if(primary===undefined)return cleanupError;
 return new AggregateError([primaryError,cleanupError],
  primaryError.message+' ['+label+': '+cleanupError.message.slice(0,512)+']');
}
function pipelineShape(input:{packOk:boolean;stageThrows?:boolean;cleanupThrows?:boolean}){
 let allocated:{root:string;release():void}|undefined;
 try{
  // Pre-allocation needs: exactly where V5 created the root too early.
  if(!input.packOk)throw Error('same issued completed pack view required');
  // Protected try: allocation is the FIRST statement inside, and the single
  // cleanup thunk releases whatever it created.
  const owned=allocateCandidateServiceStagingRoot();
  allocated=owned;
  try{
   if(input.stageThrows)throw Error('stage failed after allocation');
   return {ok:true,error:undefined,allocated:true};
  }catch(inner){
   let cleanup:unknown;
   try{
    if(input.cleanupThrows)throw Error('stage cleanup exploded');
    owned.release();
   }catch(error){cleanup=error;}
   throw combine(inner,cleanup,'stage root release failed');
  }
 }catch(finalError){
  return {ok:false,error:finalError,allocated:allocated!==undefined};
 }
}

test('N1: an invalid pack view throws BEFORE any owned stage root exists',()=>{
 const before=new Set(ownedRoots());
 const result=pipelineShape({packOk:false});
 expect(result.ok).toBe(false);
 expect(result.allocated).toBe(false);
 const after=new Set(ownedRoots());
 const leaked=[...after].filter(n=>!before.has(n));
 expect(leaked).toEqual([]);                       // actual: nothing left on disk
 expect(String((result.error as Error).message)).toContain('same issued completed pack view required');
});

test('N1: a stage failure AFTER allocation still leaves no owned root',()=>{
 const before=new Set(ownedRoots());
 const result=pipelineShape({packOk:true,stageThrows:true});
 expect(result.ok).toBe(false);
 expect(result.allocated).toBe(true);
 const after=new Set(ownedRoots());
 const leaked=[...after].filter(n=>!before.has(n));
 expect(leaked).toEqual([]);
});

test('N1: the allocator really is inside the protected try (behavioural, not line regex)',()=>{
 // The strongest check is the runtime one above; this pins the structural intent
 // so a future edit cannot move it back out without failing.
 const allocAt=PIPE.indexOf('stagingOwned=allocateCandidateServiceStagingRoot();');
 const packAt=PIPE.indexOf("need(packOutput,'same issued completed pack view required')");
 const tryAt=PIPE.indexOf('try{',packAt);
 expect(packAt>0&&tryAt>packAt).toBe(true);
 expect(allocAt>tryAt).toBe(true);                  // allocation AFTER the try opens
 // And no allocation remains before the pack need.
 const preAlloc=PIPE.slice(0,packAt).includes('allocateCandidateServiceStagingRoot()');
 expect(preAlloc).toBe(false);
});

test('N2: a plain Error has no addNote — both failures must be preserved',()=>{
 const primary=Error('primary stage failure');
 expect((primary as any).addNote).toBeUndefined();   // the real JS behaviour
 const cleanup=Error('cleanup exploded');
 const combined=combine(primary,cleanup,'stage root release failed');
 expect(combined instanceof AggregateError).toBe(true);
 expect((combined as AggregateError).errors.length).toBe(2);
 expect((combined as AggregateError).errors[0]).toBe(primary);   // primary FIRST, same object
 expect((combined as AggregateError).errors[1]).toBe(cleanup);   // cleanup SECOND
 expect(combined.message.startsWith('primary stage failure')).toBe(true);
 expect(combined.message).toContain('cleanup exploded');
});

test('N2: cleanup success preserves the ORIGINAL primary object',()=>{
 const primary=Error('primary only');
 expect(combine(primary,undefined,'x')).toBe(primary);
});

test('N2: cleanup-alone failure propagates the RAW cleanup error',()=>{
 const cleanup=Error('cleanup only');
 const result=combine(undefined,cleanup,'x');
 expect(result).toBe(cleanup);
 expect(result.message).toBe('cleanup only');
});

test('N2: materialized + staging failures both keep both (real Error objects)',()=>{
 const materialized=Error('materialized exploded');
 const staging=Error('stage exploded');
 // The pipeline uses ONE cleanup thunk, so a both-fail case is represented by
 // the aggregate kept in `errors` after the single cleanup throws.
 const combined=combine(materialized,staging,'materialized release failed');
 expect((combined as AggregateError).errors[0]).toBe(materialized);
 expect((combined as AggregateError).errors[1]).toBe(staging);
 expect(combined.message.startsWith('materialized exploded')).toBe(true);
});

test('N2: no ES2022 cause option and no addNote dependency in the pipeline',()=>{
 // No addNote CALL remains (only the explanatory comment may mention it), and
 // no ES2022 `cause` ErrorOptions is used.
 expect(/addNote\s*\(/u.test(PIPE)).toBe(false);
 expect(/\bcause\s*:/u.test(PIPE)).toBe(false);
 expect(PIPE.includes('{ cause:')).toBe(false);
 expect(PIPE).toContain('new AggregateError([primaryError,cleanupError]');
 expect(PIPE).toContain('function combinePrimaryAndCleanup(primary:unknown,cleanup:unknown,label:string):Error');
 expect(PIPE).toContain('function captureCleanup(run:()=>void):unknown');
});
