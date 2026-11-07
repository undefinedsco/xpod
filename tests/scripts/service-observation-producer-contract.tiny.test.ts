import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';

const PRODUCER='qlever/scripts/sdk-service-image-originals.py';
const FLAGS=['--capture-service-pack-originals','--capture-service-runtime-members','--capture-service-abi-originals'];

// Parse the real continued shell command with Python's standard shlex. Nothing is
// evaluated; quoted environment variables and deadline expressions stay opaque.
function captureInvocations(){
 const found:Array<{workflow:string;job:string;args:string[]}>=[];
 for(const workflow of ['candidate','release']){
  const doc=parse(readFileSync(`.github/workflows/${workflow}.yml`,'utf8')) as any;
  for(const [job,value] of Object.entries<any>(doc.jobs??{})){
   for(const step of value.steps??[]){
    const script:string=typeof step.run==='string'?step.run:'';
    const commands=script.replace(/\\\r?\n/gu,' ').split('\n');
    for(const command of commands.filter(line=>line.includes(PRODUCER))){
     const parsed=spawnSync('python3',['-c','import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read(), comments=True)))'],{input:command,encoding:'utf8'});
     expect(parsed.status).toBe(0);
     const tokens=JSON.parse(parsed.stdout) as string[];
     const at=tokens.indexOf(PRODUCER);
     expect(at).toBeGreaterThan(-1);
     found.push({workflow,job,args:tokens.slice(at+1)});
    }
   }
  }
 }
 return found;
}

test('real whole-service capture commands request pack, runtime and ABI evidence',()=>{
 const invocations=captureInvocations();
 expect(invocations.filter(row=>row.workflow==='candidate'&&row.job==='build_image')).toHaveLength(1);
 for(const {args} of invocations){
  const metadata=args.indexOf('--build-metadata');
  expect(metadata).toBeGreaterThan(-1);
  expect(args.indexOf('--deadline')).toBeGreaterThan(metadata);
  for(const flag of FLAGS){
   expect(args.filter(token=>token===flag)).toHaveLength(1);
   expect(args.indexOf(flag)<metadata).toBe(true);
  }
  // Existing non-capture options each consume one value. Inserting a switch
  // between an option and its value must also fail this contract.
  for(let index=0;index<args.length;){
   const option=args[index++]!;
   expect(option.startsWith('--')).toBe(true);
   if(FLAGS.includes(option))continue;
   expect(args[index]).toBeDefined();
   expect(args[index++]!.startsWith('--')).toBe(false);
  }
 }
});

test('the actual producer CLI accepts the required capture options',()=>{
 const help=spawnSync('python3',['-I','-S','-B',PRODUCER,'--help'],{encoding:'utf8'});
 expect(help.status).toBe(0);
 for(const flag of FLAGS)expect(help.stdout).toContain(flag);
});
