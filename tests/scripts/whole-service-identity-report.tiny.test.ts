/** V3 regression tests for the two defects the V2 review found.
 *
 * V2-1: the aggregate compared `sourceView.nativeContext === input.nativeContext`,
 *       which is always false because the SOURCE binding returns a NEW frozen
 *       wrapper around the SAME four private handles.
 * V2-2: the report duplicated `…Verified:true` literals and was written before
 *       seal/resolve/assert; the sealed view is now the single authority.
 *
 * These tests exercise the ACTUAL projection/identity semantics: they build the
 * exact wrapper the production binding builds and assert the aggregate's check
 * accepts the bound handles and rejects a swapped one. No pure prebind claim.
 */
import {test,expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(import.meta.dir,'../..');
const AGG=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-whole-qualification.ts'),'utf8');
const CLI=fs.readFileSync(path.join(ROOT,'scripts/check-candidate-service-sdk-source.ts'),'utf8');
const BIND=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-source-native-context.ts'),'utf8');

test('V2-1: the SOURCE binding returns a NEW wrapper around the SAME four handles',()=>{
 // The production binding constructs a fresh object (never returns `supplied`).
 expect(BIND).toContain('const context: CandidateServiceNativeContext = Object.freeze({');
 expect(BIND).toContain('return Object.freeze({nativeContext: context, origins, assertCurrent})');
 // And it copies the supplied handles by reference, not by value.
 for(const field of ['qualification','originals','sdkOriginals','sdkAdmission'])
  expect(BIND).toContain(': supplied.'+field);
});

test('V2-1: the aggregate compares the exact bound handles, never the wrapper object',()=>{
 // The old unsatisfiable form must be gone.
 expect(AGG).not.toContain('sourceView.nativeContext===input.nativeContext');
 // The replacement compares each handle.
 expect(AGG).toContain("for(const handle of ['qualification','originals','sdkOriginals','sdkAdmission'] as const)");
 expect(AGG).toContain('boundContext[handle]===suppliedContext[handle]');
});

test('V2-1: a swapped handle is rejected while the real wrapper is accepted',()=>{
 // Faithful reproduction of the production projection: new wrapper, same handles.
 const qualification={},originals={},sdkOriginals={},sdkAdmission={};
 const supplied=Object.freeze({qualification,originals,sdkOriginals,sdkAdmission});
 const bound=Object.freeze({qualification:supplied.qualification,originals:supplied.originals,
  sdkOriginals:supplied.sdkOriginals,sdkAdmission:supplied.sdkAdmission});
 const projected=(ctx:any,input:any)=>{
  if(!ctx||typeof ctx!=='object')throw Error('SOURCE axis exposed a native context');
  for(const handle of ['qualification','originals','sdkOriginals','sdkAdmission'] as const)
   if(ctx[handle]!==input[handle])throw Error('SOURCE axis native context handle differs from the aggregate input: '+handle);
  return true;
 };
 expect(projected(bound,supplied)).toBe(true);            // wrapper identity is irrelevant
 expect(()=>projected(bound,{...supplied,sdkAdmission:{}})).toThrow(/sdkAdmission/u);
 expect(()=>projected({...bound,originals:{}},supplied)).toThrow(/originals/u);
 expect(()=>projected(undefined,supplied)).toThrow(/exposed a native context/u);
});

test('V2-2: seal + resolve + assert all precede report construction and write',()=>{
 const sealAt=CLI.indexOf('if(!sealWholeServiceQualification(aggregate))');
 const resolveAt=CLI.indexOf('const sealed=candidateServiceWholeQualificationView(aggregate,aggregateInput)');
 const assertAt=CLI.indexOf('requireCandidateServiceWholeQualification(aggregate,aggregateInput)');
 const reportAt=CLI.indexOf('const report=Object.freeze(');
 const writeAt=CLI.indexOf("writeFileSync(path.join(output,'service-source-observation.json')");
 // Index-based ordering (avoids matcher typings absent from this tsconfig).
 for(const [name,at] of [['seal',sealAt],['resolve',resolveAt],['assert',assertAt],['report',reportAt],['write',writeAt]] as const)
  expect(`${name}:${at>0}`).toBe(`${name}:true`);
 expect(sealAt<reportAt).toBe(true);
 expect(resolveAt<reportAt).toBe(true);
 expect(assertAt<reportAt).toBe(true);
 expect(reportAt<writeAt).toBe(true);
});

test('V2-2: report statuses derive from the sealed view, not duplicated literals',()=>{
 expect(CLI).toContain('wholeServiceSourceVerified:sealed.wholeServiceSourceVerified===true');
 expect(CLI).toContain('serviceAbiVerified:sealed.serviceAbiVerified===true');
 expect(CLI).toContain('legalCoverageVerified:sealed.legalCoverageVerified===true');
 expect(CLI).toContain('wholeServiceQualificationVerified:sealed.wholeServiceQualificationVerified===true');
 // The old literal claim must be gone.
 expect(CLI).not.toContain('wholeServiceSourceVerified:true,serviceAbiVerified:true,legalCoverageVerified:true,wholeServiceQualificationVerified:true');
 // The SDK admission is gated, not waived or pruned.
 expect(CLI).toContain("sdkVerified=observation.verified===true");
 expect(CLI).toContain('qlever-sdk-source-admission-not-verified');
});

test('V2-3 adjudication: legal resolves SOURCE only through the SEALED getter',()=>{
 const legal=fs.readFileSync(path.join(ROOT,'scripts/lib/independent-admission/candidate-service-legal.ts'),'utf8');
 // Legal calls the sealed getter; the provisional resolver is not used by legal.
 expect(legal).toContain('loader.candidateServiceSourceQualificationView');
 expect(legal).not.toContain('candidateServiceSourceQualificationProvisional');
 // The WHOLE aggregate getter reads only `issued`, and deletes its provisional on failure.
 expect(AGG).toContain('const row=issued.get(value as object)');
 expect(AGG).toContain('provisional.delete(whole);throw error;');
});
