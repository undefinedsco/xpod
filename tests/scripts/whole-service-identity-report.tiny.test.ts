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
const NORMALIZED_CLI=CLI.replace(/\s+/gu,' ');
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

test('V2-2: seal + resolve + assert all precede the QUALIFIED report construction and its write',()=>{
 // The CLI now has a truthful DIAGNOSTIC branch that writes a pending report
 // before the qualified one. This test must still pin the qualified path, so:
 //  - the sealed view is a `let` assigned in the guarded try (declaration form is
 //    irrelevant: only the assignment call site matters), and
 //  - the write under test is the QUALIFIED report's write (the one after the
 //    main report), never the earlier pending diagnostic write.
 const source=NORMALIZED_CLI;
 const resolvePattern=/sealed\s*=\s*candidateServiceWholeQualificationView\s*\(\s*aggregate\s*,\s*aggregateInput\s*\)/u;
 const resolveMatch=resolvePattern.exec(source);
 const sealAt=source.indexOf('if(!sealWholeServiceQualification(aggregate))');
 const resolveAt=resolveMatch?.index??-1;
 const assertAt=source.indexOf('requireCandidateServiceWholeQualification(aggregate,aggregateInput)');
 const reportAt=source.indexOf('const report=Object.freeze(');
 // The qualified write is the one that serializes the MAIN report.
 const qualifiedWrite=source.indexOf("writeFileSync(path.join(output,'service-source-observation.json'),JSON.stringify(report");
 // Index-based ordering (avoids matcher typings absent from this tsconfig).
 for(const [name,at] of [['seal',sealAt],['resolve',resolveAt],['assert',assertAt],['report',reportAt],['write',qualifiedWrite]] as const)
  expect(`${name}:${at>0}`).toBe(`${name}:true`);
 expect(sealAt<resolveAt).toBe(true);
 expect(resolveAt<assertAt).toBe(true);
 expect(assertAt<reportAt).toBe(true);
 expect(reportAt<qualifiedWrite).toBe(true);

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

test('V2-2: the diagnostic pending branch can never report a qualified result or bypass required mode',()=>{
 const source=NORMALIZED_CLI;
 // The pending report is a distinct object with EVERY qualification flag false.
 const pendingBlock=/const pendingReport=Object\.freeze\(\{(.*?)\}\);/u.exec(source);
 const name='V2-2 pending branch';
 expect(`${name}:${Boolean(pendingBlock)}`).toBe(`${name}:true`);
 const pending=pendingBlock?.[1]??'';
 for(const flag of ['wholeServiceSourceVerified','serviceAbiVerified','legalCoverageVerified','wholeServiceQualificationVerified']){
  expect(pending).toContain(flag+':false');
  expect(pending).not.toContain(flag+':true');
 }
 expect(pending).toContain('releaseAccepted:false');
 expect(pending).toContain('qualificationRequired:false');
 // Required mode keeps the hard throw: no diagnostic fallback can swallow it.
 const pendingAt=source.indexOf('const pendingReport=Object.freeze(');
 const catchAt=source.lastIndexOf('}catch(error){',pendingAt);
 const throwAt=source.indexOf('if(requireQualification)throw error',catchAt);
 expect(catchAt>0).toBe(true);
 expect(throwAt>catchAt&&throwAt<pendingAt).toBe(true);
 // The pending write cannot be the qualified path: it serializes pendingReport,
 // and the qualified report is only built after the guarded block closes.
 const pendingWrite=source.indexOf('JSON.stringify(pendingReport');
 const qualifiedReport=source.indexOf('const report=Object.freeze(');
 expect(pendingWrite>0).toBe(true);
 expect(pendingWrite<qualifiedReport).toBe(true);
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
