/** Pure reader bridge: replays the source-owned ELF parser over caller-held
 * bytes only. No image/source qualification is claimed or issued here. */
import{expect,test}from'bun:test';
import{readFileSync}from'node:fs';
import{resolve}from'node:path';
import{replayCandidateServiceElfLoader}from'../../scripts/lib/independent-admission/candidate-service-abi-role-replay';
const SOURCE=readFileSync(resolve('qlever/scripts/sdk-service-abi-elf.py'));
const HEADER=64,PHENTRY=56,MAXRANGE=64*1024;
/** Minimal executable ELF64LE x64: 64-byte header plus one 56-byte entry. */
function minimalElf(options:{interpreter?:string;phnum?:number;declaredFilesz?:number}={}):Buffer{
 const interpreter=options.interpreter===undefined?undefined:Buffer.from(options.interpreter+'\0','utf8'),dataOffset=HEADER+PHENTRY,size=dataOffset+(interpreter?.length??0);
 const dynamic=interpreter!==undefined,bytes=Buffer.alloc(size);
 bytes.set([0x7f,0x45,0x4c,0x46,2,1,1],0);
 bytes.writeUInt16LE(2,16);bytes.writeUInt16LE(62,18);bytes.writeUInt32LE(1,20);
 bytes.writeBigUInt64LE(BigInt(HEADER),32);
 bytes.writeUInt16LE(HEADER,52);bytes.writeUInt16LE(PHENTRY,54);bytes.writeUInt16LE(options.phnum??1,56);
 bytes.writeUInt32LE(dynamic?3:1,HEADER);bytes.writeUInt32LE(0,HEADER+4);
 bytes.writeBigUInt64LE(dynamic?BigInt(dataOffset):0n,HEADER+8);
 bytes.writeBigUInt64LE(0n,HEADER+16);bytes.writeBigUInt64LE(0n,HEADER+24);
 const filesz=options.declaredFilesz??(dynamic?interpreter.length:size);
 bytes.writeBigUInt64LE(BigInt(filesz),HEADER+32);bytes.writeBigUInt64LE(BigInt(filesz),HEADER+40);bytes.writeBigUInt64LE(0n,HEADER+48);
 if(interpreter)bytes.set(interpreter,dataOffset);
 return bytes;
}
function harness(){
 const ranges:Array<[number,number]>=[],controls={guards:0};
 const run=(bytes:Buffer,guard:()=>void=()=>{})=>replayCandidateServiceElfLoader({
  source:SOURCE,bytes:bytes.length,
  read(offset,length){ranges.push([offset,length]);return bytes.subarray(offset,offset+length);},
  budget:{check(){},remainingMs(){return 60000;}},
  guard(){controls.guards++;guard();},
 });
 return{ranges,run,guards:()=>controls.guards};
}
test('actual source parser replays minimal static PT_LOAD over exact 64+56 ranges',()=>{
 const h=harness(),bytes=minimalElf();
 expect(h.run(bytes)).toEqual({kind:'static',machine:62});
 expect(h.ranges).toEqual([[0,64],[64,56]]);
 expect(h.ranges.every(([offset,length])=>offset+length<=bytes.length&&length<=MAXRANGE)).toBe(true);
 expect(h.guards()).toBe(3);
});
test('actual source parser replays PT_INTERP path over exact ranges bounded by 64 KiB',()=>{
 const h=harness(),interpreter='/lib64/ld-linux-x86-64.so.2',bytes=minimalElf({interpreter});
 expect(h.run(bytes)).toEqual({kind:'dynamic',machine:62,interpreter});
 const segment=Buffer.from(interpreter+'\0','utf8').length;
 expect(h.ranges).toEqual([[0,64],[64,56],[120,segment]]);
 expect(h.ranges.every(([,length])=>length>=1&&length<=MAXRANGE)).toBe(true);
 expect(h.ranges.reduce((total,[,length])=>total+length,0)).toBe(bytes.length);
});
test('actual bounded table refuses out-of-range phnum and interpreter length',()=>{
 const table=harness(),claimed=minimalElf({phnum:2000});
 expect(()=>table.run(claimed)).toThrow('Bounded complete actual ELF program table');
 expect(table.ranges).toEqual([[0,64]]);
 const segment=harness(),oversized=minimalElf({interpreter:'/x',declaredFilesz:4097});
 expect(()=>segment.run(oversized)).toThrow('Bounded actual interpreter');
 expect(segment.ranges).toEqual([[0,64],[64,56]]);
});
test('actual parent check exception aborts the replay before any read',()=>{
 const h=harness(),bytes=minimalElf({interpreter:'/lib64/ld-linux-x86-64.so.2'}),revoked=Error('parent qualification revoked');
 let thrown:unknown;
 try{h.run(bytes,()=>{throw revoked;});}catch(error){thrown=error;}
 expect(thrown).toBe(revoked);
 expect((thrown as Error).message).toBe('parent qualification revoked');
 expect(h.ranges).toEqual([]);
 expect(h.guards()).toBe(1);
});
