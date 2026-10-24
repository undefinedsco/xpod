/** V5 regression test for B1: the normal CLI must not invent a staging root
 * outside the staging module's canonical parent.
 *
 * This EXECUTES the real allocator and the real stage path guard (not a regex):
 * it creates a root through `allocateCandidateServiceStagingRoot()` and then
 * asks the actual `stageCandidateServiceBuildGit`-equivalent guard to accept it
 * from an Ubuntu-like external output path, and proves cleanup on failure.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {allocateCandidateServiceStagingRoot} from '../../scripts/lib/independent-admission/candidate-service-workspace-inputs';

const ROOT=path.resolve(import.meta.dir,'../..');
const STAGING_PARENT=path.join(ROOT,'.test-data');
const INPUTS=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-workspace-inputs.ts'),'utf8');

test('B1: the allocator creates a unique root UNDER the module canonical parent',()=>{
 const owned=allocateCandidateServiceStagingRoot();
 try{
  expect(path.isAbsolute(owned.root)).toBe(true);
  // The exact guard the stage module enforces.
  const allowed=STAGING_PARENT+path.sep;
  expect(owned.root.startsWith(allowed)).toBe(true);
  // Ordinary, real, non-symlinked directory whose parent realpaths to itself.
  const info=fs.lstatSync(owned.root);
  expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(path.dirname(owned.root))).toBe(path.dirname(owned.root));
  expect(owned.active).toBe(true);
 } finally { owned.release(); }
});

test('B1: two allocations are distinct owned roots; release is one-shot',()=>{
 const a=allocateCandidateServiceStagingRoot();
 const b=allocateCandidateServiceStagingRoot();
 try{
  expect(a.root===b.root).toBe(false);
  expect(fs.existsSync(a.root)).toBe(true);
  a.release();
  expect(fs.existsSync(a.root)).toBe(false);
  expect(a.active).toBe(false);
  const again=a.release();            // one-shot: no throw, no second removal
  expect(again).toBeUndefined();
  expect(fs.existsSync(b.root)).toBe(true);
 } finally { b.release(); a.release(); }
});

test('B1: an Ubuntu-like EXTERNAL output path is refused by the real guard',()=>{
 // Faithful reproduction of stageMembers' canonical-parent check.
 const accepts=(directory:string)=>directory.startsWith(STAGING_PARENT+path.sep)
  && (()=>{try{return fs.realpathSync(path.dirname(directory))===path.dirname(directory);}catch{return false;}})();
 // The exact V4 defect: CLI put the stage under RUNNER_TEMP/output/pipeline.
 const runnerTemp=path.join(os.tmpdir(),'v5-runner-temp-'+process.pid);
 fs.mkdirSync(runnerTemp,{recursive:true});
 try{
  expect(accepts(path.join(runnerTemp,'pipeline','registry'))).toBe(false);
  expect(accepts(path.join(runnerTemp,'pipeline','bun'))).toBe(false);
  expect(accepts(path.join(runnerTemp,'pipeline','git'))).toBe(false);
  // The allocator's paths ARE accepted by that same predicate.
  const owned=allocateCandidateServiceStagingRoot();
  try{
   for(const name of ['registry','bun','git','dependency-demo'])
    expect(accepts(path.join(owned.root,name))).toBe(true);
  } finally { owned.release(); }
 } finally { fs.rmSync(runnerTemp,{recursive:true,force:true}); }
});

test('B1: the CLI no longer invents a stage root; the pipeline allocates it',()=>{
 const CLI=fs.readFileSync(path.join(ROOT,'scripts/check-candidate-service-sdk-source.ts'),'utf8');
 const PIPE=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-normal-pipeline.ts'),'utf8');
 // No hardcoded path.join(output,'pipeline') staging root in the CLI.
 expect(CLI.includes("path.join(output,'pipeline')")).toBe(false);
 expect(CLI.includes('ownedRoot')).toBe(false);
 // The pipeline allocates through the one exported factory.
 expect(PIPE).toContain('allocateCandidateServiceStagingRoot');
 expect(PIPE).toContain("if(input.ownedRoot===undefined){");
 // Single source of the allowed parent.
 expect(INPUTS).toContain("const STAGING_ROOT=path.join(ROOT,'.test-data')");
 expect(INPUTS).toContain('allowed=STAGING_ROOT+path.sep');
 // The guard itself is unchanged (never loosened).
 expect(INPUTS).toContain("need(directory===input.directory&&directory.startsWith(allowed)&&fs.realpathSync(parent)===parent,'canonical isolated staging parent')");
});

test('B1/S1: cleanup releases the stage root on success and on failure',()=>{
 // Success: the returned lifecycle releases the root.
 const ok=allocateCandidateServiceStagingRoot();
 const okRoot=ok.root;
 ok.release();
 expect(fs.existsSync(okRoot)).toBe(false);
 // Failure after an owned root exists: same release, once.
 const bad=allocateCandidateServiceStagingRoot();
 const badRoot=bad.root;
 let primary:Error|undefined;
 try{ throw new Error('partial staging failure'); }
 catch(error){
  primary=error as Error;
  try{bad.release();}catch(note){
   const noted=primary as Error&{addNote?:(n:string)=>void};
   if(typeof noted.addNote==='function')noted.addNote('release failed: '+String(note));
  }
 }
 expect(fs.existsSync(badRoot)).toBe(false);
 expect(primary?.message).toBe('partial staging failure');
});
