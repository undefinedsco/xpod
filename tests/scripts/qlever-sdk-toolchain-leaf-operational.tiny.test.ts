/** OPERATIONAL LEAF REGRESSION. This file executes the REAL
 * observeQleverSdkToolchainSourceOriginals entry point, not the aggregate leaf
 * and not a pure helper. Only the private-view PROTOCOL functions are stubbed, so
 * the actual coverage/currentness code inside the leaf runs.
 *
 * It exists because the previous source passed pure-helper and aggregate tests
 * while the operational leaf threw a temporal-dead-zone error before reaching any
 * validation: `assertCurrent` was invoked while the `generatedWitness` /
 * `generatedInputs` / `generatedGraph` lexical bindings were still uninitialized.
 *
 * NO AUTHORITY IS MINTED HERE. The stubs return fixed objects only; nothing in
 * this file can register a capability, and no test asserts whole-SDK closure.
 */
import {test, expect, beforeEach} from 'bun:test';
// The repository's `bun:test` type shim declares the assertion surface but not
// `mock.module`. Bun provides it at runtime; declare the narrow shape this file
// uses so `typecheck:test` stays honest without widening the shared shim.
const bunTest = require('bun:test') as typeof import('bun:test') & {
  mock: { module(specifier: string, factory: () => Record<string, unknown>): void };
};
const mock = bunTest.mock;

const source={sourceSha:'a'.repeat(40)};
const sdk={originFacts:{sourceSha:source.sourceSha},readOriginal:()=>Buffer.from('{}')};
let execution:any;
let inputs:any;
// The verified input-ownership view: every input mapped to its signed-Debian
// binary/source tuple. This is byte authority; no test flag can mint it.
let ownershipRows:any[]=[];
let toolsCurrent=0;

const reset=()=>{
  toolsCurrent=0;
  inputs={rows:[],afterReference:{path:'after.json',bytes:2,sha256:'b'.repeat(64)},
    ownership:{inputRows:[],unresolvedInputs:[]}};
  ownershipRows=[];
  execution={
    sdkActualConfigureCompileTrackedWaitVerified:true,
    // A REAL nonempty coverage projection is required for the leaf to enter the
    // actual join; an empty one is refused, which is asserted separately below.
    sdkToolchainOperationCoverage:{schemaVersion:1,operations:[{
      kind:'exec',phase:'compile',pid:4242,entrySequence:10,execEventSequence:11,captureSequence:12,
      primaryFile:{observedPath:'/usr/bin/cc',identityDecimal:['1','2',String(0o100755),'4096','1700000000000000001','1700000000000000002'],
        original:{path:'capture-0001.original',bytes:4096,sha256:'c'.repeat(64)},originalCaptureSequence:13},
      elf:{machine:183},mapOriginals:[],expectedFileMappingCount:0,unresolved:[]}],pending:[]},
    sdkVerifiedGeneratedProducerWitness:[],sdkVerifiedGeneratedProducerInputs:[],
    sdkVerifiedGeneratedProducerGraph:undefined,
    // The decoder always exports this table now; a private execution view with
    // no custody table must FAIL CLOSED (asserted below), not skip the check.
    sdkVerifiedRegularReadCustody:[],sdkVerifiedRegularReadSourceClass:[],
  };
};

mock.module('../../scripts/lib/independent-admission/qlever-sdk-originals',()=>({qleverSdkOriginalsView:()=>sdk}));
mock.module('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:()=>source,assertDerivedSourceCurrent:()=>{}}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-source',()=>({
  // Complete surface used by OTHER suites that share this module id in the same
  // test process: a partial factory would break their imports.
  sdkVerifiedInputOriginalView:()=>inputs,
  sdkVerifiedSourceArchiveOriginalView:()=>undefined,
  inspectQleverSdkSourceOriginals:async()=>({facts:{},pending:[]}),
  inspectSdkCompositeSourceRetirement:()=>({retired:false,reason:'test'}),
  SDKB_COMPOSITE_SOURCE_GAP:undefined,
  SDK_COMPOSITE_SOURCE_GAP:'test-gap',
  SDK_SOURCE_REQUIRED_AXES:[],
  qleverSdkSourceAdmissionView:()=>undefined,
  observeQleverSdkSourceOriginals:async()=>({facts:{},pending:[]}),
  observeQleverSdkSourceAdmission:async()=>({facts:{},pending:[],verified:false})}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-generation',()=>({qleverSdkExecutionOriginalObservation:()=>execution}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-debian-binary',()=>({qleverSdkDebianBinaryObservation:()=>undefined}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-debian-index',()=>({qleverSdkDebianIndexObservation:()=>undefined}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-debian-signature',()=>({qleverSdkDebianSignatureObservation:()=>undefined}));
mock.module('../../scripts/lib/independent-admission/qlever-sdk-observed-tools',()=>({
  observeQleverSdkObservedToolOriginals:async()=>({facts:{sdkObservedToolAfterShardFiles:[]},pending:[],
    assertCurrent:()=>{toolsCurrent++;}})}));

const {observeQleverSdkToolchainSourceOriginals}=await import('../../scripts/lib/independent-admission/qlever-sdk-toolchain-source');

beforeEach(reset);

test('the ACTUAL leaf reaches real coverage validation instead of throwing a temporal-dead-zone error',async()=>{
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  // The TDZ failure used to SWALLOW everything into a private-coverage error.
  expect(result.pending.join(' ')).not.toContain('before initialization');
  expect(result.pending.join(' ')).not.toContain('private-coverage-unverified');
  // the coverage join really ran
  expect(result.facts.sdkToolchainOperationCount).toBe(1);
  expect(result.facts.sdkToolchainExecutionCount).toBe(1);
  // and closure is still refused (no whole-SDK claim)
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('an EMPTY coverage projection is still refused, not accepted as complete',async()=>{
  execution.sdkToolchainOperationCoverage={schemaVersion:1,operations:[],pending:[]};
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(result.pending.join(' ')).toContain('complete nonempty operation projection required');
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('a REPLACED shared input table is refused by the currentness guard',async()=>{
  // The guard must hold the exact array identity, so swapping the table after the
  // leaf read it invalidates the observation rather than silently re-joining.
  const original=[{inputId:0,identity:['1','9',String(0o100644),'1','1','1'],bytes:1,sha256:'d'.repeat(64),
    entrySequence:5,captureSequence:6,inputModel:'mapping',lifetimeLeaseSequence:4,protection:1,flags:0,executable:false}];
  execution.sdkVerifiedGeneratedProducerInputs=original;
  execution.sdkVerifiedGeneratedProducerWitness=[{path:'/out/build/a.o',bytes:1,sha256:'e'.repeat(64),
    identity:['1','10',String(0o100644),'1','1','1'],completedCloseSequence:50,producerCaptureSequence:45,
    inputIds:[0],inputComplete:true,readOperations:0,inputObligationCount:1,readInputCount:0,mappingInputCount:1,
    execImage:{pid:4242,phase:'compile',exe:'/usr/bin/cc',identity:['1','2',String(0o100755),'1','1','1'],bytes:1,sha256:'f'.repeat(64)}}];
  const first=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(first.assertCurrent).toBeDefined();
  // replace the table with a fresh array of equal content
  execution.sdkVerifiedGeneratedProducerInputs=original.map(row=>({...row}));
  expect(()=>first.assertCurrent!()).toThrow('custody changed');
});

test('a private execution view WITHOUT the custody table fails closed',async()=>{
  delete (execution as any).sdkVerifiedRegularReadCustody;
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(result.pending.join(' ')).toContain('regular-read custody table unavailable');
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('a REPLACED custody table is refused by the currentness guard',async()=>{
  execution.sdkVerifiedRegularReadCustody=[{leaseSequence:5,identity:['1','9',String(0o100644),'1','1','1'],
    bytes:1,sha256:'d'.repeat(64),entrySequence:4,captureSequence:6,acquisitionEntrySequence:4,exitSequence:7}];
  const first=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(first.assertCurrent).toBeDefined();
  execution.sdkVerifiedRegularReadCustody=execution.sdkVerifiedRegularReadCustody.map((r:any)=>({...r}));
  expect(()=>first.assertCurrent!()).toThrow('custody changed');
});

test('an unchanged shared input table passes the currentness guard',async()=>{
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(()=>result.assertCurrent!()).not.toThrow();
  expect(toolsCurrent).toBeGreaterThan(0);
});

/** MULTI-PRODUCER SHARED-LEASE ACCEPTANCE.
 *
 * Two independent producer PIDs read the SAME shared header under the SAME held
 * kernel read lease and each produce an output. This is the real C++ build shape:
 * a compiler pool reuses one lease epoch across processes. Every read is a
 * different entry/capture under one acquisition, so per-read custody must accept
 * BOTH and the source origin must come from the verified ownership tuple.
 */

/** Coverage whose mapping originals ARE the two produced outputs, so each output
 * is classified generated-producer and joined against the derived witness. */
// NOTE: ownership rows here carry the PRODUCTION shape only
// {path,role,observedBeforeCompile,owners}. They deliberately have NO bytes/sha:
// byte identity lives in the verified input rows.
const compileOutputOwnership=():{inputRows:any[];unresolvedInputs:any[]}=>({inputRows:[],unresolvedInputs:[
  {path:'/out/build/a.o',role:'compile-output',reason:'generated-build-output-source-causality-unverified'},
  {path:'/out/build/b.o',role:'compile-output',reason:'generated-build-output-source-causality-unverified'}]});
const coverageWith=()=>({schemaVersion:1,operations:[{
  kind:'exec',phase:'compile',pid:4242,entrySequence:10,execEventSequence:11,captureSequence:12,
  primaryFile:{observedPath:'/usr/bin/cc',identityDecimal:['1','2',String(0o100755),'4096','1','1'],
    original:{path:'capture-0001.original',bytes:4096,sha256:'c'.repeat(64)},originalCaptureSequence:13},
  elf:{machine:183},
  mapOriginals:[0,1].map(i=>({
    observedPath:i===0?'/out/build/a.o':'/out/build/b.o',
    identityDecimal:['1',String(9000+ (i===0?7:9)),String(0o100644),'8','1','1'],
    original:{path:'capture-00'+String(20+i)+'.original',bytes:8,
      sha256:String(i===0?7:9).padStart(2,'0').repeat(64).slice(0,64)},
    originalCaptureSequence:30+i,captureSequence:30+i,
    mapping:{startHex:'1000',endHex:'2000',path:i===0?'/out/build/a.o':'/out/build/b.o',
      inode:9000+(i===0?7:9),deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'}})),
  expectedFileMappingCount:2,unresolved:[]}],pending:[]});

const sharedIdentity=['1','4242',String(0o100644),'64','1700000000000000001','1700000000000000002'];
const sharedRead=(entry:number,capture:number,pid:number,inputId=0)=>({
  inputId,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),protection:1,flags:0,
  lifetimeLeaseSequence:100,executable:false,inputModel:'regular-read',
  resolvedPath:'/usr/include/shared.h',entrySequence:entry,captureSequence:capture,
  regularRead:{form:'pread64',fd:3,rangeStart:0,consumedLength:64,result:64,
    exitSequence:capture+2,captureSequence:capture,generation:{identity:sharedIdentity,flags:0,position:0},
    iovcnt:null,iovLengths:null,readLeaseSequence:100}});
const outputFor=(pid:number,path:string,inputId=0)=>({path,bytes:8,sha256:String(pid).padStart(2,'0').repeat(64).slice(0,64),
  identity:['1',String(9000+pid),String(0o100644),'8','1','1'],phase:'compile',producerPid:pid,
  completedCloseSequence:500,producerCaptureSequence:400,inputIds:[inputId],inputComplete:true,readOperations:0,
  inputObligationCount:1,readInputCount:1,mappingInputCount:0,
  execImage:{pid,phase:'compile',exe:'/usr/bin/clang++-19',identity:['1','5',String(0o100755),'1','1','1'],bytes:1,sha256:'e'.repeat(64)}});

test('two producer PIDs sharing ONE held lease both close source from real ownership',async()=>{
  const readA=sharedRead(20,21,7,0),readB=sharedRead(60,61,9,1);
  inputs={rows:[{originalPath:'/usr/include/shared.h',bytes:64,sha256:'7'.repeat(64),mode:0o644}],
    afterReference:{path:'after.json',bytes:2,sha256:'b'.repeat(64)},
    ownership:{inputRows:[{path:'/usr/include/shared.h',bytes:64,sha256:'7'.repeat(64),role:'observed-input',
      owners:[{binary:'libc6',binaryVersion:'2.39',source:{name:'glibc',version:'2.39'}}]}],unresolvedInputs:[]}};
  execution.sdkVerifiedGeneratedProducerInputs=[readA,readB];
  execution.sdkVerifiedGeneratedProducerWitness=[outputFor(7,'/out/build/a.o',0),outputFor(9,'/out/build/b.o',1)];
  execution.sdkVerifiedRegularReadCustody=[
    {leaseSequence:100,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),entrySequence:20,
      captureSequence:21,acquisitionEntrySequence:20,exitSequence:23,phase:'compile',pid:7},
    {leaseSequence:100,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),entrySequence:60,
      captureSequence:61,acquisitionEntrySequence:20,exitSequence:63,phase:'compile',pid:9}];
  execution.sdkVerifiedGeneratedProducerGraph=undefined;
  execution.sdkToolchainOperationCoverage=coverageWith();
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(result.pending.join(' ')).not.toContain('private-coverage-unverified');
  expect(result.pending.join(' ')).not.toContain('not the exported custody association');
  expect(()=>result.assertCurrent!()).not.toThrow();
});

test('the SAME two-PID shape FAILS when one custody row is dropped',async()=>{
  const readA=sharedRead(20,21,7,0),readB=sharedRead(60,61,9,1);
  const own=compileOutputOwnership();
  own.inputRows=[{path:'/usr/include/shared.h',bytes:64,sha256:'7'.repeat(64),role:'observed-input',
    owners:[{binary:'libc6',binaryVersion:'2.39',source:{name:'glibc',version:'2.39'}}]}];
  inputs={rows:[{originalPath:'/usr/include/shared.h',bytes:64,sha256:'7'.repeat(64),mode:0o644}],
    afterReference:{path:'after.json',bytes:2,sha256:'b'.repeat(64)},ownership:own};
  execution.sdkVerifiedGeneratedProducerInputs=[readA,readB];
  execution.sdkVerifiedGeneratedProducerWitness=[outputFor(7,'/out/build/a.o',0),outputFor(9,'/out/build/b.o',1)];
  execution.sdkVerifiedRegularReadCustody=[
    {leaseSequence:100,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),entrySequence:20,
      captureSequence:21,acquisitionEntrySequence:20,exitSequence:23,phase:'compile',pid:7}];
  execution.sdkToolchainOperationCoverage=coverageWith();
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  // The dropped association must surface as a generated-origin pending for THAT
  // output, and closure must stay false.
  expect(result.pending.join(' ')).toContain('qlever-sdk-generated-build-output-producer-source-causality-unverified');
  expect(result.pending.join(' ')).not.toContain('private-coverage-unverified: SDK toolchain coverage: generated witness input ids');
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('the SAME two-PID shape FAILS when the ownership origin is missing',async()=>{
  const readA=sharedRead(20,21,7,0),readB=sharedRead(60,61,9,1);
  inputs={rows:[{originalPath:'/usr/include/shared.h',bytes:64,sha256:'7'.repeat(64),mode:0o644}],
    afterReference:{path:'after.json',bytes:2,sha256:'b'.repeat(64)},
    ownership:compileOutputOwnership()};
  execution.sdkVerifiedGeneratedProducerInputs=[readA,readB];
  execution.sdkVerifiedGeneratedProducerWitness=[outputFor(7,'/out/build/a.o',0),outputFor(9,'/out/build/b.o',1)];
  execution.sdkVerifiedRegularReadCustody=[
    {leaseSequence:100,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),entrySequence:20,
      captureSequence:21,acquisitionEntrySequence:20,exitSequence:23,phase:'compile',pid:7},
    {leaseSequence:100,identity:sharedIdentity,bytes:64,sha256:'7'.repeat(64),entrySequence:60,
      captureSequence:61,acquisitionEntrySequence:20,exitSequence:63,phase:'compile',pid:9}];
  execution.sdkToolchainOperationCoverage=coverageWith();
  const result=await observeQleverSdkToolchainSourceOriginals({},{});
  expect(result.pending.join(' ')).toContain('qlever-sdk-generated-build-output-producer-source-causality-unverified');
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});
