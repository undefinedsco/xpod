import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inspectNativeLicenseArchiveReader} from '../../scripts/lib/independent-admission/candidate-service-native-license-reader';
const scannerSource=readFileSync('qlever/scripts/sdk-service-native-license-archive.py');
const archive=spawnSync('python3',['-c',"import io,tarfile,gzip,sys\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode='w') as t:\n i=tarfile.TarInfo('pkg/LICENSE');i.size=3;t.addfile(i,io.BytesIO(b'abc'))\nsys.stdout.buffer.write(gzip.compress(b.getvalue()))"],{maxBuffer:1048576});
if(archive.status!==0)throw Error('Actual archive fixture failed');const raw=archive.stdout;
function input(){let readBytes=0,reserved=0;return{archive:{bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')},scannerSource,assertCurrent(){},read(offset:number,length:number){if(length>65536)throw Error('range');readBytes+=length;return raw.subarray(offset,offset+length);},budget:{check(){},remainingMs(){return 10000;},remainingReadBytes(){return 100000-readBytes;},chargeReadBytes(n:number){readBytes+=n;if(readBytes>100000)throw Error('shared read ceiling');},reserveBytes(n:number){reserved+=n;}},counts:()=>({readBytes,reserved})};}
test('real scanner child receives held ranges and decoded charges on one parent',async()=>{
 const i=input(),r=await inspectNativeLicenseArchiveReader(i);expect(r.texts[0]!.text.toString()).toBe('abc');expect(r.members.length).toBe(1);expect(i.counts().readBytes).toBe(raw.length+r.expandedBytes);expect(i.counts().reserved>0).toBe(true);
});
test('parent refusal during decoded bytes kills and awaits actual child, preserving error',async()=>{
 const i=input(),stop=Error('parent revoked');i.budget.chargeReadBytes=()=>{throw stop;};let failure:unknown;try{await inspectNativeLicenseArchiveReader(i);}catch(error){failure=error;}expect(failure).toBe(stop);
});
test('actual checksum mismatch cannot return scanner result',async()=>{
 const i=input();i.archive.sha256='0'.repeat(64);await expect(inspectNativeLicenseArchiveReader(i)).rejects.toThrow('did not close successfully');
});
test('revocation immediately after spawn waits for actual scanner child disappearance',async()=>{
 const i=input(),revoked=Error('post-spawn revoked');let calls=0;let owned:number[]=[];
 i.budget.remainingMs=()=>{if(++calls===2){const ps=spawnSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'});if(ps.status!==0)throw Error('process inventory failed');owned=ps.stdout.split('\n').map(line=>line.trim().split(/\s+/u)).filter(parts=>Number(parts[1])===process.pid&&/python/iu.test(parts.slice(2).join(' '))).map(parts=>Number(parts[0]));throw revoked;}return 10000;};
 let failure:unknown;try{await inspectNativeLicenseArchiveReader(i);}catch(error){failure=error;}
 expect(failure).toBe(revoked);expect(owned.length).toBeGreaterThan(0);
 for(const pid of owned){let absent=false;try{process.kill(pid,0);}catch(error){absent=(error as NodeJS.ErrnoException).code==='ESRCH';}expect(absent).toBe(true);}
});
test('actual pipe returns requested original member bytes and rejects absent selection',async()=>{
 const i=input(),r=await inspectNativeLicenseArchiveReader({...i,selectedMembers:['pkg/LICENSE']});expect(r.selectedTexts[0]!.text.toString()).toBe('abc');expect(r.textBytes).toBe(3);
 await expect(inspectNativeLicenseArchiveReader({...input(),selectedMembers:['pkg/missing.h']})).rejects.toThrow('did not close successfully');
});
