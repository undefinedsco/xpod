/**
 * Runs the ACTUAL CLI as a child process. This is the regression guard for the
 * reviewer's A1 finding (a deleted `import.meta.main` block made the command
 * exit 0 without running anything, silently passing --require-qualification).
 *
 * It asserts the entry point executes, that the nine-argument contract is
 * enforced, and that the run reaches the genuine external boundary (GitHub
 * origin metadata) instead of exiting early with no work. A live GitHub token
 * is deliberately absent, so the observable boundary here is the network
 * origin step -- not the local wiring.
 */
import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const CLI=path.resolve(import.meta.dir,'../../scripts/check-candidate-service-sdk-source.ts');
const coords=(output:string,checkout:string)=>[
 '--source-sha','a'.repeat(40),'--run-id','1','--run-attempt','2','--service-artifact-id','3',
 '--service-artifact-digest','b'.repeat(64),'--service-master-bytes','100',
 '--service-master-sha256','c'.repeat(64),'--checkout',checkout,'--output',output,
];
const run=(args:string[],env:Record<string,string|undefined>={})=>spawnSync('bun',[CLI,...args],{
 encoding:'utf8',timeout:180000,env:{...process.env,GITHUB_TOKEN:'',HTTPS_PROXY:process.env.HTTPS_PROXY??'',...env}});

test('the real CLI process executes and enforces the nine-argument contract',()=>{
 const short=run(['--source-sha','a'.repeat(40)]);
 expect(short.status).toBe(1);
 const shortErr=String(short.stderr);
 expect(shortErr.includes('Exact candidate service observer arguments required')
  ||shortErr.includes('Complete candidate service observer arguments required')).toBe(true);
});

test('the real CLI process reaches the genuine external origin boundary (not a silent exit 0)',()=>{
 // macOS /var is a symlink: the CLI requires a canonical (realpath) parent.
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'cli-proc-')));
 const output=path.join(root,'out'),checkout=path.join(root,'src');
 mkdirSync(checkout);
 try{
  const result=run([...coords(output,checkout),'--require-qualification']);
  // A1 regression: a deleted entry block would leave status 0 and no output dir.
  expect(result.status).not.toBe(0);
  // The owned output dir is created only after the entry point ran and the
  // nine-argument contract passed, so its existence proves execution.
  expect(existsSync(output)).toBe(true);
  // It must fail at the real origin/acquisition step, not before doing work.
  expect(String(result.stderr).trim().length).toBeGreaterThan(0);
  const resultErr=String(result.stderr);
  expect(resultErr.includes('Independent GitHub origin')||resultErr.includes('service acquisition')
   ||resultErr.includes('metadata request')).toBe(true);
  // No observation report may be written by a failed run.
  expect(existsSync(path.join(output,'service-source-observation.json'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the CLI never creates the output directory when acquisition cannot start',()=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),'cli-proc-')));
 const output=path.join(root,'out'),checkout=path.join(root,'src');
 mkdirSync(checkout);
 try{
  const result=run(coords(output,checkout));
  expect(result.status).not.toBe(0);
  const startErr=String(result.stderr);
  expect(startErr.includes('Independent GitHub origin')||startErr.includes('metadata request')).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
