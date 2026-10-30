/** REAL CONTRACT TEST: actual inspectSdkInputOwnership -> actual frozen
 * ownership projection -> actual sdkVerifiedInputOriginalView getter -> actual
 * toolchain leaf. Nothing here invents ownership row fields.
 *
 * The previous tests hand-built rows with invented bytes/sha256, which is exactly
 * how the production defect (ownership rows carry NO bytes) escaped. This test
 * consumes the genuine row shape {path,role,observedBeforeCompile,owners}.
 */
import {test, expect} from 'bun:test';
import {inspectSdkInputOwnership} from '../../scripts/lib/independent-admission/qlever-sdk-inputs';

const hash=(s:string)=>require('node:crypto').createHash('sha256').update(Buffer.from(s)).digest('hex');
const HEADER='/usr/include/shared.h', HEADER_TEXT='#pragma once\n';
const sha256=(bytes:Buffer)=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const OUT='/out/build/a.o', OUT_TEXT='OBJ';


/** Build a legal ustar shard for the two real members, so the ACTUAL
 * inspectSdkInputOwnership parser runs (no shard shortcut). */
const buildShard=(members:readonly [string,number,Buffer][]):Buffer=>{
  const header=(name:string,size:number,mode:number)=>{
    const h=Buffer.alloc(512);
    const oct=(value:number,width:number)=>value.toString(8).padStart(width,'0');
    h.write(name,0,'utf8');h.write(oct(mode,7)+'\0',100,'utf8');
    h.write('0000000\0',108,'utf8');h.write('0000000\0',116,'utf8');
    h.write(oct(size,11)+'\0',124,'utf8');h.write('00000000000\0',136,'utf8');
    h.write('0',156,'utf8');h.write('ustar\0',257,'utf8');h.write('00',263,'utf8');
    // checksum field = 6 octal digits + NUL + space; the parser excludes the
    // field bytes and substitutes spaces.
    h.write(' '.repeat(8),148,'utf8');
    let sum=0;for(const b of h)sum+=b;
    h.write(oct(sum,6)+'\0 ',148,'utf8');
    return h;
  };
  const parts:Buffer[]=[];
  for(const [name,mode,data] of members){
    parts.push(header(name,data.length,mode),data,Buffer.alloc((512-data.length%512)%512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
};

const paddedShard=():Buffer=>{
  const shard=buildShard([[HEADER.slice(1),0o644,Buffer.from(HEADER_TEXT)],
    [OUT.slice(1),0o644,Buffer.from(OUT_TEXT)]]);
  return Buffer.concat([shard,Buffer.alloc(Math.max(0,1024-shard.length))]);
};
const makeInput=()=>({
  before:{},
  after:{schemaVersion:1,packageOwnershipOriginals:[],files:[
    {originalPath:HEADER,archivePath:HEADER.slice(1),bytes:Buffer.byteLength(HEADER_TEXT),
      sha256:hash(HEADER_TEXT),mode:0o644,role:'observed-input'},
    {originalPath:OUT,archivePath:OUT.slice(1),bytes:Buffer.byteLength(OUT_TEXT),
      sha256:hash(OUT_TEXT),mode:0o644,role:'compile-output'}]},
  shards:(()=>{const shard=paddedShard();
    return [{path:'shard-0.original',bytes:shard.length,sha256:sha256(shard)}];})(),
  ledger:{},
  readRange:()=>paddedShard(),
  check:()=>{},
});

test('the REAL ownership result has exactly the production row shape (no bytes/sha)',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  expect(ownership.inputRows.length).toBe(2);
  for(const row of ownership.inputRows){
    expect(Object.keys(row).sort()).toEqual(['observedBeforeCompile','owners','path','role']);
    expect((row as any).bytes).toBeUndefined();
    expect((row as any).sha256).toBeUndefined();
  }
});

test('the REAL ownership marks the compile-output row and keeps observed-input unresolved',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const header=ownership.inputRows.find(r=>r.path===HEADER)!;
  const out=ownership.inputRows.find(r=>r.path===OUT)!;
  expect(header.role).toBe('observed-input');
  expect(header.observedBeforeCompile).toBe(false);
  expect(out.role).toBe('compile-output');
  // an observed-input with no dpkg owner is a real residual
  expect(ownership.unresolvedInputs.some(r=>r.path===HEADER&&r.role==='observed-input')).toBe(true);
});

/** MAPPED-SOURCE REAL CONTRACT.
 *
 * The mapping input edge the publisher derives carries NO path and NO source
 * tuple: it is built from `toolchain-mapping-original`, and the canonical target
 * lives in the coverage's own validated `mapOriginals` record for the SAME
 * capture sequence. This case drives the REAL ownership result into the REAL
 * leaf with exactly those production shapes, so the fix cannot regress into
 * either (a) crediting a mapped input with no origin, or (b) demanding regular-
 * read-only fields (resolvedPath/regularRead custody) a mapping edge never has.
 */
import {inspectSdkToolchainOperationFileCoverage} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';

const mappedEdge=()=>({entrySequence:20,captureSequence:21,
  identity:['1','41',String(0o100644),String(Buffer.byteLength(HEADER_TEXT)),'1700000000000000001','1700000000000000002'],
  bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT),protection:1,flags:0,
  lifetimeLeaseSequence:19,executable:false,inputModel:'mapping'});

const mappedCoverage=(edge:any,outWitness:any)=>({schemaVersion:1,pending:[] as string[],operations:[{
  kind:'exec',phase:'compile',pid:7,entrySequence:1,execEventSequence:2,captureSequence:3,
  primaryFile:{observedPath:'/usr/bin/clang++-19',
    identityDecimal:['1','8001',String(0o100755),'4096','1700000000000000001','1700000000000000002'],
    original:{path:'capture-0001.original',bytes:4096,sha256:'c'.repeat(64)},originalCaptureSequence:4},
  elf:{machine:183},
  mapOriginals:[
    {observedPath:OUT,identityDecimal:outWitness.identity,
      original:{path:'capture-0010.original',bytes:Buffer.byteLength(OUT_TEXT),sha256:hash(OUT_TEXT)},
      originalCaptureSequence:10,captureSequence:10,
      mapping:{startHex:'1000',endHex:'1010',path:OUT,inode:41,deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'}},
    // THE validated mapped byte observation for this edge's own capture.
    {observedPath:HEADER,identityDecimal:edge.identity,
      original:{path:'capture-0020.original',bytes:edge.bytes,sha256:edge.sha256},
      originalCaptureSequence:20,captureSequence:edge.captureSequence,
      mapping:{startHex:'2000',endHex:'2010',path:HEADER,inode:41,deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'}}],
  expectedFileMappingCount:2,unresolved:[] as string[]}]});

const mappedInput=(ownership:any,over:any={})=>{
  const edge=mappedEdge();
  const headerBytes=Buffer.byteLength(HEADER_TEXT);
  const witness={path:OUT,bytes:Buffer.byteLength(OUT_TEXT),sha256:hash(OUT_TEXT),
    identity:['1','91',String(0o100644),String(Buffer.byteLength(OUT_TEXT)),'1700000000000000001','1700000000000000002'],
    phase:'compile',producerPid:7,completedCloseSequence:50,producerCaptureSequence:45,
    inputComplete:true,readOperations:0,inputObligationCount:1,readInputCount:0,mappingInputCount:1,
    execImage:{pid:7,phase:'compile',exe:'/usr/bin/clang++-19',
      identity:['1','8001',String(0o100755),'4096','1700000000000000001','1700000000000000002'],
      bytes:4096,sha256:'c'.repeat(64)}};
  return {coverage:mappedCoverage(edge,witness),
    observedFiles:[{path:OUT,phase:'compile',captureSequence:10,identityDecimal:witness.identity,
      bytes:witness.bytes,sha256:witness.sha256,mode:0o644}],
    afterRows:[{originalPath:OUT,bytes:witness.bytes,sha256:witness.sha256,mode:0o644},
      {originalPath:HEADER,bytes:headerBytes,sha256:hash(HEADER_TEXT),mode:0o644}],
    originProvenance:new Map([[OUT,'compile-output' as const]]),
    generatedWitness:[{...witness,inputIds:[0]}],
    generatedInputs:[{...edge,inputId:0}],
    generatedReadCustody:[],
    // The REAL archived inventory: path/bytes/sha/mode. This IS the byte authority.
    verifiedInputRows:[{originalPath:HEADER,bytes:headerBytes,sha256:hash(HEADER_TEXT),mode:0o644}],
    // The REAL ownership projection: NO bytes/sha of its own.
    verifiedOwnershipRows:ownership.inputRows,
    binaryFiles:[],verifiedGitPostpatchMembers:[],verifiedGitSourceRoot:'/opt/qlever-sdk/source',
    ...over} as any;
};

test('REAL rows: a mapped input closes SOURCE only through its validated mapped observation',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const r=inspectSdkToolchainOperationFileCoverage(mappedInput(ownership));
  // No dpkg owner, no Git member, no prepared row => no closed origin exists.
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('mapping input origin is unresolved');
});

test('REAL rows: a mapped input WITHOUT any validated mapped observation never mints a path',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership);
  input.coverage.operations[0].mapOriginals=[input.coverage.operations[0].mapOriginals[0]];
  input.coverage.operations[0].expectedFileMappingCount=1;
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no validated mapped byte observation');
});

test('REAL rows: a mapped observation whose byte image differs cannot close the edge',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership);
  input.generatedInputs[0].sha256='9'.repeat(64);
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('REAL rows: a mapped input bound to a prepared byte row DOES close, with no read-only fields',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const headerBytes=Buffer.byteLength(HEADER_TEXT);
  const r=inspectSdkToolchainOperationFileCoverage(mappedInput(ownership,{
    // A closed independent byte authority for the EXACT image. The mapping edge
    // still carries no resolvedPath/regularRead, which must not be demanded.
    verifiedPreparedByteRows:[{path:HEADER,bytes:headerBytes,sha256:hash(HEADER_TEXT),mode:0o644}]}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
  expect(r.facts.sdkToolchainGeneratedProducerMappingInputCreditedCount).toBe(1);
  // and the closed origin is published for the aggregate's per-row join
  expect((r.facts.sdkToolchainGeneratedProducerInputOrigins as readonly any[])
    .some(row=>row.path===HEADER&&row.closed===true)).toBe(true);
});

/** CLOSED-OUTPUT AGGREGATE CONTRACT.
 *
 * A fully closed producer OUTPUT is not an INPUT of its own producer, so it can
 * never appear in `sdkToolchainGeneratedProducerInputOrigins`. It must be
 * discharged by the leaf's own post-graph-validation output fact, joined on the
 * exact path/bytes/mode. These cases pin BOTH directions with REAL row shapes.
 */
test('a FULLY CLOSED producer output is published as a CLOSED OUTPUT, distinct from inputs',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const headerBytes=Buffer.byteLength(HEADER_TEXT);
  const r=inspectSdkToolchainOperationFileCoverage(mappedInput(ownership,{
    verifiedPreparedByteRows:[{path:HEADER,bytes:headerBytes,sha256:hash(HEADER_TEXT),mode:0o644}]}));
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
  const outputs=(r.facts.sdkToolchainGeneratedProducerClosedOutputs as readonly any[]);
  const inputs=(r.facts.sdkToolchainGeneratedProducerInputOrigins as readonly any[]);
  // the producer's OWN output is closed...
  expect(outputs.some(row=>row.path===OUT&&row.closed===true)).toBe(true);
  // ...and is NOT misreported as an input origin of the same producer.
  expect(inputs.some(row=>row.path===OUT)).toBe(false);
  expect(inputs.some(row=>row.path===HEADER)).toBe(true);
});

test('an UNCLOSED producer output publishes NO closed-output fact',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  // Remove the only input origin, so the witness graph must refuse.
  const r=inspectSdkToolchainOperationFileCoverage(mappedInput(ownership,{
    verifiedPreparedByteRows:[],verifiedOwnershipRows:[],binaryFiles:[]}));
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
  expect((r.facts.sdkToolchainGeneratedProducerClosedOutputs as readonly any[]).length).toBe(0);
});

test('A ROLE OR BOOLEAN ALONE closes nothing: no leaf fact means the output row stays open',()=>{
  // The row shape the aggregate sees for a build output, and the leaf facts the
  // aggregate must join against. With no closed-output fact the row cannot close.
  const row={path:OUT,role:'compile-output',reason:'generated-build-output-source-causality-unverified'};
  const actual={path:OUT,bytes:Buffer.byteLength(OUT_TEXT),sha256:hash(OUT_TEXT),mode:0o755};
  const closed=(facts:any)=>Array.isArray(facts.sdkToolchainGeneratedProducerClosedOutputs)
    &&facts.sdkToolchainGeneratedProducerClosedOutputs.some((entry:any)=>entry&&entry.path===row.path
      &&entry.bytes===actual.bytes&&entry.sha256===actual.sha256&&entry.mode===actual.mode
      &&entry.closed===true);
  expect(closed({})).toBe(false);
  // a same-path row with DIFFERENT bytes never closes it
  expect(closed({sdkToolchainGeneratedProducerClosedOutputs:[{...actual,sha256:'9'.repeat(64),closed:true}]})).toBe(false);
  // a same-bytes row at a DIFFERENT path never closes it
  expect(closed({sdkToolchainGeneratedProducerClosedOutputs:[{...actual,path:'/other/bin',closed:true}]})).toBe(false);
  // mode is part of the byte image
  expect(closed({sdkToolchainGeneratedProducerClosedOutputs:[{...actual,mode:0o644,closed:true}]})).toBe(false);
  // the exact fact does close it
  expect(closed({sdkToolchainGeneratedProducerClosedOutputs:[{...actual,closed:true}]})).toBe(true);
});

/** MAPPED OBSERVATION COLLISION CONTRACT (F1-PHASEA-IMAGE-KEY-COLLISION).
 *
 * A mapped observation is VMA/capture-level; the whole-file image key is
 * FILE-level. The publisher's own mapping identity includes startHex/endHex/
 * fileOffset, so one file legitimately yields several `mapOriginals`, and two
 * producer PIDs may map one shared object in the same phase. Repeated
 * observations must therefore never abort ingestion: the exact
 * (phase, captureSequence) key stays unique and authoritative, while the file
 * image is a candidate multimap resolved PER EDGE. Equivalent observations that
 * name the same canonical path+mode+byte image are one source target; genuinely
 * different targets are still refused rather than guessed.
 */
const sharedVma=(observedPath:string,captureSequence:number,originalCaptureSequence:number,
  startHex:string,endHex:string,fileOffset:number)=>({observedPath,
  identityDecimal:mappedEdge().identity,
  original:{path:`capture-00${originalCaptureSequence}.original`,
    bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT)},
  originalCaptureSequence,captureSequence,
  mapping:{startHex,endHex,path:observedPath,inode:41,deviceMajor:0,deviceMinor:1,fileOffset,
    permissions:'r--p'}});

test('PLAIN SDK: the same file mapped twice does NOT abort the inspection (no witness at all)',()=>{
  // Decisive shape: Phase A runs for every mapOriginal even with NO generated
  // producer, so a collision here would regress the whole toolchain leaf.
  const headerBytes=Buffer.byteLength(HEADER_TEXT);
  const coverage={schemaVersion:1,pending:[] as string[],operations:[{
    kind:'exec',phase:'compile',pid:7,entrySequence:1,execEventSequence:2,captureSequence:3,
    primaryFile:{observedPath:'/usr/bin/clang++-19',
      identityDecimal:['1','8001',String(0o100755),'4096','1700000000000000001','1700000000000000002'],
      original:{path:'capture-0001.original',bytes:4096,sha256:'c'.repeat(64)},originalCaptureSequence:4},
    elf:{machine:183},
    mapOriginals:[sharedVma(HEADER,21,20,'2000','2008',0),
      sharedVma(HEADER,22,20,'3000','3008',8)],
    expectedFileMappingCount:2,unresolved:[] as string[]}]};
  let r:any;
  expect(()=>{r=inspectSdkToolchainOperationFileCoverage({coverage,
    observedFiles:[],afterRows:[],binaryFiles:[],verifiedInputRows:[],
    verifiedOwnershipRows:[],originProvenance:new Map()} as any);}).not.toThrow();
  expect(r.facts.sdkToolchainOperationCoverageVerified).toBe(true);
  expect(r.facts.sdkToolchainMappedVmaCount).toBe(2);
  expect(headerBytes).toBeGreaterThan(0);
});

test('one file / two VMA ranges with a legitimate generated edge still CREDITS',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership,{verifiedPreparedByteRows:[
    {path:HEADER,bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT),mode:0o644}]});
  // a SECOND VMA of the same file, at another range/offset
  input.coverage.operations[0].mapOriginals.push(sharedVma(HEADER,22,21,'3000','3008',8));
  input.coverage.operations[0].expectedFileMappingCount=3;
  let r:any;
  expect(()=>{r=inspectSdkToolchainOperationFileCoverage(input);}).not.toThrow();
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
  expect(r.facts.sdkToolchainGeneratedProducerPending).toHaveLength(0);
});

test('two producer PIDs sharing one mapped header do NOT abort the inspection',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership,{verifiedPreparedByteRows:[
    {path:HEADER,bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT),mode:0o644}]});
  // a second producer, same phase, mapping the SAME shared header again
  input.coverage.operations.push({kind:'mmap',phase:'compile',pid:9,
    entrySequence:30,exitSequence:31,captureSequence:32,
    mapOriginals:[sharedVma(HEADER,40,39,'2000','2010',0)],
    expectedFileMappingCount:1,unresolved:[] as string[]});
  let r:any;
  expect(()=>{r=inspectSdkToolchainOperationFileCoverage(input);}).not.toThrow();
  expect(r.facts.sdkToolchainOperationCount).toBe(2);
  // the first producer's own mapped edge still closes normally
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
});

test('TRULY AMBIGUOUS fallback candidates are still refused, not guessed',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership,{verifiedPreparedByteRows:[
    {path:HEADER,bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT),mode:0o644}]});
  // Force the image-key FALLBACK (the edge's capture has no exact observation) with
  // TWO candidates that share identity+bytes+sha but name DIFFERENT canonical targets.
  input.generatedInputs[0].captureSequence=99;
  input.coverage.operations[0].mapOriginals.push(
    {...sharedVma('/usr/include/other.h',41,42,'3000','3008',8),
     identityDecimal:mappedEdge().identity});
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' '))
    .toContain('mapping input fallback matches 2 distinct canonical targets');
});

test('EQUIVALENT repeats of one source target collapse and still close',()=>{
  const ownership=inspectSdkInputOwnership(makeInput() as any);
  const input=mappedInput(ownership,{verifiedPreparedByteRows:[
    {path:HEADER,bytes:Buffer.byteLength(HEADER_TEXT),sha256:hash(HEADER_TEXT),mode:0o644}]});
  // same fallback trigger, but BOTH candidates name the SAME canonical path+mode
  input.generatedInputs[0].captureSequence=99;
  input.coverage.operations[0].mapOriginals.push(sharedVma(HEADER,41,42,'3000','3008',8));
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
});
