import {test, expect} from 'bun:test';
import {observeCandidateServiceNativeRuntimeOriginals, candidateServiceNativeRuntimeOriginalsView, nativeRuntimePendingAfterSignature, readNativeRuntimeLocalHelper} from '../../scripts/lib/independent-admission/candidate-service-native-runtime-originals';

test('serialized or copied native report never becomes source authority', () => {
  for (const value of [undefined, {}, {verified: true, facts: {sourceAuthorityVerified: true}}, Object.freeze({verified: true, pending: []})])
    expect(candidateServiceNativeRuntimeOriginalsView(value, {}, {}, {}, {})).toBeUndefined();
});
test('reject caller native JSON before reading budget or invoking any external observer', async () => {
  let touched = false;
  const touch = () => {touched = true; throw Error('must not touch');};
  await expect(observeCandidateServiceNativeRuntimeOriginals({originals: {verified: true}, source: {}, sdkOriginals: {}, sdkAdmission: {verified: true},
    budget: {check: touch, remainingMs: touch, reserveBytes: touch, chargeReadBytes: touch}})).rejects.toThrow('sole collected native originals required');
  expect(touched).toBe(false);
});

test('live signature axis can settle index sentinel without erasing unknown failures or minting a cap', () => {
  const sentinel = 'qlever-sdk-official-Debian-keyring-gpgv-and-suite-authority-unverified';
  const complete = nativeRuntimePendingAfterSignature({mechanics: [], index: [sentinel], signature: [], signatureVerified: true});
  expect(complete).toEqual([]);
  expect(candidateServiceNativeRuntimeOriginalsView(complete, {}, {}, {}, {})).toBeUndefined();
  expect(nativeRuntimePendingAfterSignature({mechanics: ['kernel-gap'], index: [sentinel, 'unknown-index'], signature: ['signature-gap'], signatureVerified: true}))
    .toEqual(['kernel-gap', 'unknown-index', 'signature-gap']);
  expect(nativeRuntimePendingAfterSignature({mechanics: [], index: [sentinel], signature: [], signatureVerified: false})).toEqual([sentinel]);
});

test('local native helper charges captured bytes before read and preserves custody/deadline',()=>{
 const fs=require('node:fs'),path=require('node:path');const base=path.resolve('.test-data/native-helper-read');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'case-')),file=path.join(dir,'helper.py');
 try{const bytes=Buffer.from('actual source helper');fs.writeFileSync(file,bytes);let charged=0;
 const budget={check(){},remainingMs(){return 1000;},chargeReadBytes(n:number){charged+=n;}};
 expect(readNativeRuntimeLocalHelper(file,budget).bytes.equals(bytes)).toBe(true);expect(charged).toBe(bytes.length);
 const stop=Error('parent read exhausted');let failure:unknown;try{readNativeRuntimeLocalHelper(file,{...budget,chargeReadBytes(){throw stop;}});}catch(error){failure=error;}expect(failure).toBe(stop);
 expect(()=>readNativeRuntimeLocalHelper(file,{...budget,remainingMs(){return 0;}})).toThrow('deadline');
 expect(()=>readNativeRuntimeLocalHelper(file,{...budget,chargeReadBytes(){fs.appendFileSync(file,'changed');}})).toThrow('custody changed');
 fs.truncateSync(file,4*1024*1024+1);let touched=false;expect(()=>readNativeRuntimeLocalHelper(file,{...budget,chargeReadBytes(){touched=true;}})).toThrow('byte ceiling');expect(touched).toBe(false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
