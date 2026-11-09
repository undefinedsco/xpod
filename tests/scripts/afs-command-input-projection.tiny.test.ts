/** Command-input logical projection, exercised through the REAL exported helper
 * from `packages/xpod-afs/scripts/build-client.ts`.
 *
 * `projectCommandInputPath` is the single classification+projection used by the
 * production command graph; the optional `implementation` parameter makes the
 * Windows shape executable on any host. Nothing here mirrors the predicate or
 * inspects source text.
 */
import {test,expect} from 'bun:test';
import path from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {projectCommandInputPath,COMMAND_INPUT_OUTSIDE_ROOTS}=require('../../packages/xpod-afs/scripts/build-client');

// The exact Windows layout from the failing CI job.
const WIN_ROOTS={
  producerRoot:'D:\\a\\xpod\\xpod\\.test-data\\afs-producer-build-MZZ2MA\\cli\\package',
  dependencyRoot:'D:\\a\\xpod\\xpod\\node_modules',
  repoRoot:'D:\\a\\xpod\\xpod',
};

test('Windows: outside producer but inside repo projects to a repo-relative path',()=>{
 // The reported failure: an in-repo file that lives outside the staged producer.
 expect(projectCommandInputPath('D:\\a\\xpod\\xpod\\dist\\commands-source.ts',WIN_ROOTS,path.win32))
  .toBe('dist/commands-source.ts');
 // A sibling directory sharing the producer prefix is not "inside" it: the
 // relative form is `..\\package-other\\x.mjs`, which the containment test
 // rejects, so it falls through to the repo-relative branch.
 expect(projectCommandInputPath('D:\\a\\xpod\\xpod\\.test-data\\afs-producer-build-MZZ2MA\\cli\\package-other\\x.mjs',WIN_ROOTS,path.win32))
  .toBe('.test-data/afs-producer-build-MZZ2MA/cli/package-other/x.mjs');
 // A different drive is outside every declared root. `path.win32.relative`
 // returns the ABSOLUTE `E:\\...` form, which must be refused rather than
 // normalized into a logical path that merely lacks a leading slash.
 expect(()=>projectCommandInputPath('E:\\elsewhere\\repo\\dist\\commands-source.ts',WIN_ROOTS,path.win32))
  .toThrow(COMMAND_INPUT_OUTSIDE_ROOTS);
});

test('paths outside every declared root are refused on both implementations',()=>{
 // Windows: other drive, and a sibling tree alongside the repo.
 expect(()=>projectCommandInputPath('E:\\elsewhere\\repo\\dist\\commands-source.ts',WIN_ROOTS,path.win32))
  .toThrow(COMMAND_INPUT_OUTSIDE_ROOTS);
 expect(()=>projectCommandInputPath('D:\\other-repo\\dist\\commands-source.ts',WIN_ROOTS,path.win32))
  .toThrow(COMMAND_INPUT_OUTSIDE_ROOTS);
 // POSIX: other top-level tree, and a parent traversal that leaves the repo.
 const posixRoots={producerRoot:'/repo/.test-data/afs-producer-build-x/cli/package',
  dependencyRoot:'/repo/node_modules',repoRoot:'/repo'};
 expect(()=>projectCommandInputPath('/elsewhere/repo/dist/commands-source.ts',posixRoots,path.posix))
  .toThrow(COMMAND_INPUT_OUTSIDE_ROOTS);
 expect(()=>projectCommandInputPath('/repo/../elsewhere/commands-source.ts',posixRoots,path.posix))
  .toThrow(COMMAND_INPUT_OUTSIDE_ROOTS);
 // No refusal leaks a host absolute path or a traversal segment.
 for(const outside of ['E:\\elsewhere\\repo\\dist\\commands-source.ts','D:\\other-repo\\x.mjs']){
  try{projectCommandInputPath(outside,WIN_ROOTS,path.win32);}catch(error){
   const message=String((error as Error).message);
   expect(message).toBe(COMMAND_INPUT_OUTSIDE_ROOTS);
   expect(message.includes('E:')||message.includes('D:')).toBe(false);
  }
 }
});

test('Windows: genuine producer and dependency inputs keep their logical prefixes',()=>{
 expect(projectCommandInputPath('D:\\a\\xpod\\xpod\\.test-data\\afs-producer-build-MZZ2MA\\cli\\package\\dist\\output.mjs',WIN_ROOTS,path.win32))
  .toBe('packages/xpod-cli/dist/output.mjs');
 expect(projectCommandInputPath('D:\\a\\xpod\\xpod\\node_modules\\@scope\\pkg\\dist\\index.mjs',WIN_ROOTS,path.win32))
  .toBe('node_modules/@scope/pkg/dist/index.mjs');
});

test('POSIX: same contract on the native separator',()=>{
 const roots={producerRoot:'/repo/.test-data/afs-producer-build-x/cli/package',
  dependencyRoot:'/repo/node_modules',repoRoot:'/repo'};
 expect(projectCommandInputPath('/repo/packages/xpod-afs/dist/commands-source.ts',roots,path.posix))
  .toBe('packages/xpod-afs/dist/commands-source.ts');
 expect(projectCommandInputPath('/repo/.test-data/afs-producer-build-x/cli/package/dist/output.mjs',roots,path.posix))
  .toBe('packages/xpod-cli/dist/output.mjs');
 expect(projectCommandInputPath('/repo/node_modules/left-pad/index.js',roots,path.posix))
  .toBe('node_modules/left-pad/index.js');
});

test('projected paths never traverse when fed to the real metafile projector',()=>{
 const tools=require('../../packages/xpod-cli/dist/build-tools.cjs');
 const roots={producerRoot:'/staging/producer-cli-ab12/package',dependencyRoot:'/repo/node_modules',repoRoot:'/repo'};
 const physical=['/repo/dist/commands-source.ts','/staging/producer-cli-ab12/package/dist/output.mjs'];
 const raw=Buffer.from(JSON.stringify({inputs:Object.fromEntries(physical.map(p=>[p,{bytesInOutput:1}])),outputs:{}}));
 const bindings=physical.map(p=>({physicalPath:p,logicalPath:projectCommandInputPath(p,roots,path.posix),sha256:'a'.repeat(64)}));
 const projected=JSON.parse(tools.projectBuildMetafile(raw,bindings).toString());
 expect(Object.keys(projected.inputs).sort()).toEqual(['dist/commands-source.ts','packages/xpod-cli/dist/output.mjs']);
 // The projector still refuses traversal supplied directly.
 expect(()=>tools.projectBuildMetafile(raw,[{physicalPath:physical[0],logicalPath:'packages/xpod-cli/../../dist/commands-source.ts',sha256:'a'.repeat(64)}]))
  .toThrow(/Invalid build metafile logicalPath/u);
});
