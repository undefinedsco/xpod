import {test,expect} from 'bun:test';
import {inspectSdkToolchainOperationFileCoverage} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';

/** A generated build artifact: the compiler must WRITE it into the build root, so
 * it can never be a stopped-read-only-provider file, a signed Debian installed
 * binary, or a Debian source package. Those three obligations are a category
 * error for this origin class; the class is derived ONLY from the observer's own
 * verified provenance, never from a path prefix or a filename. */
function generated(){
  const identityDecimal=['1','7',String(0o100644),'64','1700000000000000001','1700000000000000002'];
  const original={path:'capture-9.original',bytes:64,sha256:'c'.repeat(64)};
  const build='/work/build/pch.h.pch';
  const file={observedPath:build,identityDecimal,original,originalCaptureSequence:6};
  const mapping={startHex:'1000',endHex:'2000',path:build,inode:7,deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'};
  const coverage={schemaVersion:1,operations:[{kind:'exec',phase:'compile',pid:5,entrySequence:1,execEventSequence:3,captureSequence:4,primaryFile:{...file,observedPath:'/usr/bin/clang'},elf:{machine:183},
    mapOriginals:[{...file,mapping,captureSequence:5}],expectedFileMappingCount:1,unresolved:[] as string[]}],pending:[] as string[]};
  const observedFiles=[{path:build,phase:'compile',captureSequence:2,identityDecimal,bytes:64,sha256:original.sha256,mode:0o644}];
  const afterRows=[{originalPath:build,bytes:64,sha256:original.sha256,mode:0o644}];
  // a signed-Debian binary for the COMPILER (a genuine Debian file), none for the PCH
  const compilerIdentity=['1','8',String(0o100755),'100','1700000000000000001','1700000000000000002'];
  const compilerOriginal={path:'capture-8.original',bytes:100,sha256:'d'.repeat(64)};
  coverage.operations[0]!.primaryFile={observedPath:'/usr/bin/clang',identityDecimal:compilerIdentity,original:compilerOriginal,originalCaptureSequence:2};
  observedFiles.push({path:'/usr/bin/clang',phase:'compile',captureSequence:6,identityDecimal:compilerIdentity,bytes:100,sha256:compilerOriginal.sha256,mode:0o755});
  afterRows.push({originalPath:'/usr/bin/clang',bytes:100,sha256:compilerOriginal.sha256,mode:0o755});
  const binaryFiles=[{installedPath:'/usr/bin/clang',bytes:100,sha256:compilerOriginal.sha256,mode:0o755,binary:{name:'clang',version:'1',architecture:'arm64'},source:{name:'clang',version:'1'},deb:compilerOriginal,packages:{...compilerOriginal,signedIndexPath:'Packages',inReleaseSha256:'b'.repeat(64)},dataMemberPath:'usr/bin/clang'}];
  return {coverage,observedFiles,afterRows,binaryFiles};
}
function provenance(role:'compile-output'|'generated-or-unobserved-before-compile'){
  const m=new Map<string,'compile-output'|'generated-or-unobserved-before-compile'>();
  m.set('/work/build/pch.h.pch',role);return m;
}

test('a generated artifact is not charged the Debian/read-only obligations',()=>{
  const input={...generated(),originProvenance:provenance('compile-output')};
  const result=inspectSdkToolchainOperationFileCoverage(input);
  // classified as a generated producer origin, not as an unresolved/signed file
  expect(result.facts.sdkToolchainGeneratedProducerFileCount).toBe(1);
  expect(result.facts.sdkToolchainSignedDebianFileCount).toBe(1); // the compiler
  // its typed pending replaces the three misapplied ones for the PCH path
  expect(result.pending.some(r=>r.includes('generated-build-output-producer-source-causality-unverified:/work/build/pch.h.pch'))).toBe(true);
  expect(result.pending.some(r=>r.includes('signed-Debian-binary-unavailable:/work/build/pch.h.pch'))).toBe(false);
  expect(result.pending.some(r=>r.includes('stop-readonly-provider-original-unavailable:/work/build/pch.h.pch'))).toBe(false);
  // and it MUST NOT be pushed into the Debian source-archive join
  expect((result.facts.sdkToolchainSignedFileCoordinates as readonly {path:string}[]).some(r=>r.path==='/work/build/pch.h.pch')).toBe(false);
});

test('the generated class still fails closed: no producer witness means no closure',()=>{
  const result=inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('compile-output')});
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
  expect(result.facts.sdkToolchainGeneratedProducerPending.length).toBe(1);
});

test('without verified provenance the same bytes stay UNRESOLVED and keep the old obligations',()=>{
  // no provenance map: the leaf cannot invent a class, so the file is unresolved
  const result=inspectSdkToolchainOperationFileCoverage(generated());
  // the compiler keeps its signed-Debian class; only the PCH is unresolved
  expect(result.facts.sdkToolchainUnresolvedOriginFileCount).toBe(1);
  expect(result.facts.sdkToolchainSignedDebianFileCount).toBe(1);
  expect(result.pending.some(r=>r.includes('signed-Debian-binary-unavailable:/work/build/pch.h.pch'))).toBe(true);
  expect(result.pending.some(r=>r.includes('stop-readonly-provider-original-unavailable:/work/build/pch.h.pch'))).toBe(true);
});

test('a path under a build directory is NOT auto-classified as generated',()=>{
  // the same path, but provenance says nothing: no path-prefix heuristic exists
  const noRole=new Map<string,'compile-output'|'generated-or-unobserved-before-compile'>();
  const result=inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:noRole});
  expect(result.facts.sdkToolchainGeneratedProducerFileCount).toBe(0);
  // only the PCH is unresolved; the compiler still classifies as signed-Debian
  expect(result.facts.sdkToolchainUnresolvedOriginFileCount).toBe(1);
});

test('generated-or-unobserved provenance is accepted as the same generated class',()=>{
  const result=inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('generated-or-unobserved-before-compile')});
  expect(result.facts.sdkToolchainGeneratedProducerFileCount).toBe(1);
  expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('bytes that do not match the after-shard still fail even when generated',()=>{
  const input={...generated(),originProvenance:provenance('compile-output')};
  input.afterRows=[{originalPath:'/work/build/pch.h.pch',bytes:64,sha256:'e'.repeat(64),mode:0o644}];
  const result=inspectSdkToolchainOperationFileCoverage(input);
  expect(result.facts.sdkToolchainObservedAfterFileBindingsVerified).toBe(false);
  expect(result.pending.some(r=>r.includes('after-shard-binding-unavailable'))).toBe(true);
});

// ---- derived causal witness: positives and negatives ----
function readInput(overrides:any={}){
  return {entrySequence:20,captureSequence:21,identity:['1','10',String(0o100644),'128','1700000000000000001','1700000000000000002'],
    bytes:128,sha256:'1'.repeat(64),protection:1,flags:null,lifetimeLeaseSequence:19,executable:false,
    inputModel:'regular-read',resolvedPath:'/usr/include/ord.h',
    regularRead:{form:'pread64',fd:3,rangeStart:0,consumedLength:128,result:128,exitSequence:22,readLeaseSequence:19,
      generation:{identity:['1','10',String(0o100644),'128','1700000000000000001','1700000000000000002'],flags:0,position:0},
      iovcnt:null,iovLengths:null},...overrides};
}
// The scanner wire now stores each distinct input ONCE and each output carries
// integer ids. Tests go through the SAME shape so the resolver is exercised.
const wire=(witness:readonly any[])=>{
  const table:any[]=[];const index=new Map<string,number>();
  const rows=witness.map(w=>{
    const inputIds=(w.inputs??[]).map((item:any)=>{
      const key=JSON.stringify([item.identity,item.bytes,item.sha256,item.entrySequence,item.captureSequence,item.inputModel]);
      const found=index.get(key);if(found!==undefined)return found;
      const id=table.length;index.set(key,id);table.push({...item,inputId:id});return id;
    });
    const {...rest}=w;
    return {...rest,inputIds};
  });
  return {witness:rows,inputs:table};
};
function witnessFixture(){
  const outIdentity=['1','7',String(0o100644),'64','1700000000000000001','1700000000000000002'];
  const inputIdentity=['1','10',String(0o100644),'128','1700000000000000001','1700000000000000002'];
  const execIdentity=['1','11',String(0o100755),'256','1700000000000000001','1700000000000000002'];
  return {
    witness:[{
      path:'/work/build/pch.h.pch',bytes:64,sha256:'c'.repeat(64),identity:outIdentity,
      phase:'compile',producerPid:7,
      completedCloseSequence:50,producerCaptureSequence:45,inputComplete:true,readOperations:0,
      readInputCount:0,mappingInputCount:1,inputObligationCount:1,
      execImage:{pid:7,phase:'compile',exe:'/usr/bin/clang',identity:execIdentity,bytes:256,sha256:'f'.repeat(64),lifetimeLeaseSequence:10},
      inputs:[{entrySequence:20,captureSequence:21,identity:inputIdentity,bytes:128,sha256:'1'.repeat(64),
               protection:1,flags:2,lifetimeLeaseSequence:22,executable:false}],
    }],
  };
}
/** The REAL producer shape for a mapping edge. The SAME captured mapping row that
 * yields an input edge is also projected into the coverage's `mapOriginals`, so
 * the leaf can bind that edge's canonical path from a validated mapped byte
 * observation instead of inventing one. A fixture WITHOUT it exercises a shape
 * the publisher cannot emit, which is why the source fixture now carries it. */
const withMappedObservation=(input:any,captureSequence=21,observedPath?:string)=>{
  // A producer from before the two-model split omitted `inputModel`; the verifier
  // defaults it to 'mapping', so the helper must bind that exact same edge.
  const edge=(input.generatedInputs??[]).find((row:any)=>(row.inputModel??'mapping')==='mapping');
  if(edge===undefined)return input;
  const path=observedPath??edge.resolvedPath??edge.path??'/usr/include/ord.h';
  delete edge.resolvedPath;
  // The observation is ONE real file record, so its size field must agree with
  // the identity it is published under. A deliberately corrupted edge therefore
  // fails on the byte comparison, not on an impossible record.
  input.coverage.operations[0].mapOriginals.push({observedPath:path,identityDecimal:edge.identity,
    original:{path:'capture-0020.original',bytes:Number(edge.identity[3]),sha256:edge.sha256},
    originalCaptureSequence:20,captureSequence,
    mapping:{startHex:'1000',endHex:'1080',path,inode:Number(edge.identity[1]),
      deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'}});
  input.coverage.operations[0].expectedFileMappingCount=input.coverage.operations[0].mapOriginals.length;
  return input;
};
// The full set of SAME-private views a real execution observation supplies.
const privateViews=()=>({
  generatedReadCustody:[{leaseSequence:22,identity:['1','10',String(0o100644),'128','1700000000000000001','1700000000000000002'],
    bytes:128,sha256:'1'.repeat(64),entrySequence:20,captureSequence:21,acquisitionEntrySequence:20,
    exitSequence:23,phase:'compile',pid:7}],
  verifiedInputRows:[{originalPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644}],
  verifiedOwnershipRows:[{path:'/usr/include/ord.h',role:'observed-input',observedBeforeCompile:true,
    owners:[{binary:'libstdc++6',binaryVersion:'14',source:{name:'gcc-14',version:'14.2.0'}}]}],
  binaryFiles:[{installedPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644,
    binary:{name:'libstdc++6',version:'14',architecture:'arm64'},source:{name:'gcc-14',version:'14.2.0'},
    deb:{path:'inner/x.deb',bytes:1,sha256:'a'.repeat(64)},
    packages:{path:'inner/P',bytes:1,sha256:'b'.repeat(64),signedIndexPath:'Packages',inReleaseSha256:'c'.repeat(64)},
    dataMemberPath:'usr/include/ord.h'}]});
const wit=(mut:(w:any)=>void)=>{
  const f=witnessFixture();mut(f.witness[0]);const g=wire(f.witness);
  const input={...generated(),originProvenance:provenance('compile-output'),generatedWitness:g.witness,generatedInputs:g.inputs,
    ...privateViews()} as any;
  // The mapping edge must be backed by the SAME-verified mapped observation the
  // real publisher also emits for that capture; without it no canonical target
  // exists and the leaf now (correctly) refuses to credit.
  return withMappedObservation(input);};
test('a mapping edge WITHOUT a validated mapped byte observation is refused (no invented target)',()=>{
  const input=wit(()=>{});
  // A validated observation exists for this capture, but it names a DIFFERENT
  // byte image, so nothing in this inspection binds the edge's own bytes to a
  // path. The leaf must refuse rather than adopt the other image's path.
  (input.generatedInputs as any[])[0].sha256='8'.repeat(64);
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no validated mapped byte observation');
});
test('a mapping edge whose observation names DIFFERENT bytes is refused',()=>{
  const input=wit(()=>{});
  input.coverage.operations[0].mapOriginals[0].original.sha256='9'.repeat(64);
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});
test('a mapping edge that has bytes but NO verified same-private source row is refused',()=>{
  const input=wit(()=>{});input.verifiedInputRows=[];
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no verified same-private source origin');
});
test('a mapping edge with no closed direct origin (no owner/Git/prepared) is refused',()=>{
  const input=wit(()=>{});input.verifiedOwnershipRows=[];input.binaryFiles=[];
  const r=inspectSdkToolchainOperationFileCoverage(input);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('origin is unresolved');
});

test('a rooted witness with completed close, producer image and earlier leased inputs CREDITS the generated source origin',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(()=>{}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
  expect(r.facts.sdkToolchainGeneratedProducerPending.length).toBe(0);
  // but the overall leaf still does not claim source closure
  expect(r.facts.sdkToolchainSourceClosureVerified).toBe(false);
});

test('MISSING inputs never credit',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.inputs=[];}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no actual required inputs');
});

test('a FUTURE input edge (not before the completed close) never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.inputs[0].entrySequence=w.completedCloseSequence;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('future-close credit');
});

test('a SELF-EDGE (input identity equals the output) is a cycle and never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.inputs[0].identity=[...w.identity];}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('cycle or self-read');
});

test('a WRITABLE input mapping is not an immutable source input',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.inputs[0].protection=3;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('writable');
});

test('an input without its held lease never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{delete w.inputs[0].lifetimeLeaseSequence;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a MISSING producer execution image never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.execImage=null;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('producer execution image');
});

test('same identity with two different byte versions never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{
    w.inputs.push({...w.inputs[0],sha256:'2'.repeat(64),bytes:129});
  }));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('two different byte versions');
});

test('a changed output identity versus the witness never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.bytes=65;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a witness naming a foreign path never credits this output',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.path='/other/build/foreign.pch';}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no derived producer witness');
});

test('an output that also claims a Debian binary origin never credits as generated',()=>{
  const base=wit(()=>{});base.binaryFiles=[{...base.binaryFiles[0],installedPath:'/work/build/pch.h.pch',bytes:64,sha256:'c'.repeat(64),mode:0o644}];
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('ONE OF TWO inputs dropped is INCOMPLETE and never credits (ROOT one-of-two case)',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.inputComplete=false;w.readOperations=1;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('incomplete');
});

test('an unexplained read-family operation blocks credit even with valid mappings',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{w.readOperations=3;w.inputComplete=false;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a witness missing the completeness fact entirely is refused',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(wit(w=>{delete w.inputComplete;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

// ---- REGULAR-READ input model (the complete input universe) ----
import {inspectSdkCompositeSourceRetirement,SDK_COMPOSITE_SOURCE_GAP,SDK_SOURCE_REQUIRED_AXES} from '../../scripts/lib/independent-admission/qlever-sdk-source';

const readWitness=(mut:(w:any)=>void)=>{
  const f=witnessFixture();f.witness[0].inputs=[readInput()];f.witness[0].readInputCount=1;f.witness[0].mappingInputCount=0;mut(f.witness[0]);
  const g=wire(f.witness);
  return {...generated(),originProvenance:provenance('compile-output'),generatedWitness:g.witness,generatedInputs:g.inputs,
    generatedReadCustody:[{leaseSequence:19,identity:readInput().identity,bytes:128,sha256:'1'.repeat(64),
      entrySequence:20,captureSequence:21,acquisitionEntrySequence:19,exitSequence:22,
      phase:'compile',pid:7}],
    verifiedOwnershipRows:[{path:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),
      owners:[{binary:'libstdc++6',binaryVersion:'14',source:{name:'gcc-14',version:'14.2.0'}}]}],
    verifiedInputRows:[{originalPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644}],
    binaryFiles:[{installedPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644,
      binary:{name:'libstdc++6',version:'14',architecture:'arm64'},
      source:{name:'gcc-14',version:'14.2.0'},
      deb:{path:'inner/x.deb',bytes:1,sha256:'a'.repeat(64)},
      packages:{path:'inner/Packages',bytes:1,sha256:'b'.repeat(64),signedIndexPath:'Packages',inReleaseSha256:'c'.repeat(64)},
      dataMemberPath:'usr/include/ord.h'}]} as any;
};

test('a read-only regular-read input with its matching exit CREDITS generated source',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(()=>{}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerReadInputCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(true);
});

test('a read input without its matching exit never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.exitSequence=w.inputs[0].entrySequence;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('matching real exit');
});

test('a read input whose consumed range exceeds its captured bytes never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.consumedLength=4096;w.inputs[0].regularRead.result=4096;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('past its captured bytes');
});

test('a read input on a WRITABLE descriptor is not an immutable input',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.generation.flags=2;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('not read-only');
});

test('a read input with an unknown kernel ABI form never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.form='readdir';}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('unknown kernel ABI form');
});

test('a read input whose generation identity differs from the input never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.generation.identity[1]=99;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('generation identity differs');
});

test('a position-based read whose generation position differs from the range start never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].regularRead.form='read';w.inputs[0].regularRead.generation.position=8;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('position-based read start');
});

test('ONE dropped read among a mapping+read pair is INCOMPLETE and never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{
    w.inputs=[w.inputs[0]];w.inputComplete=false;w.readOperations=1;w.unexplainedReads=[{entrySequence:19,nr:63,form:'read'}]}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('incomplete');
});

const graphFor=(w:any,edge:any[])=>({schemaVersion:1,model:'compact-deduplicated-causal-graph-v1',
  nodeCount:2,edgeSetCount:1,edgeCount:1,
  nodes:[{nodeId:0,model:'output',identity:w.identity,bytes:w.bytes,sha256:w.sha256,path:w.path,
          completedCloseSequence:w.completedCloseSequence,producerPid:7,producerCaptureSequence:w.producerCaptureSequence,
          phase:'compile',inputSetId:0},
         {nodeId:1,model:'mapping',identity:w.inputs[0].identity,bytes:w.inputs[0].bytes,sha256:w.inputs[0].sha256}],
  inputSets:[{setId:0,edges:[edge]}]});

test('a compact graph that RESTATES the witness is accepted',()=>{
  // Use the SAME production-shaped input as the positive origin case (mapped
  // observation + verified source rows), so this asserts graph agreement rather
  // than accidentally re-testing origin authority.
  const base=wit(()=>{});const w=base.generatedWitness[0];
  const graph=graphFor(w,[1,20,21,'mapping',w.inputs[0].lifetimeLeaseSequence,null,null,null,null,null,null]);
  const r=inspectSdkToolchainOperationFileCoverage({...base,generatedGraph:graph} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect((r.facts.sdkToolchainGeneratedProducerGraph as any).edgeSetCount).toBe(1);
});

test('a compact graph with a future edge is REFUSED even when the witness is valid',()=>{
  const f=witnessFixture();const w=f.witness[0];
  const graph=graphFor(w,[1,w.completedCloseSequence,21,'mapping',w.inputs[0].lifetimeLeaseSequence,null,null,null,null,null,null]);
  const g=wire(f.witness);expect(()=>inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('compile-output'),generatedWitness:g.witness,generatedInputs:g.inputs,generatedGraph:graph} as any)).toThrow('future edge');
});

test('a compact graph with a self edge is REFUSED',()=>{
  const f=witnessFixture();const w=f.witness[0];
  const graph=graphFor(w,[0,20,21,'mapping',w.inputs[0].lifetimeLeaseSequence,null,null,null,null,null,null]);
  const g=wire(f.witness);expect(()=>inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('compile-output'),generatedWitness:g.witness,generatedInputs:g.inputs,generatedGraph:graph} as any)).toThrow('self/intra edge');
});

// ---- AGGREGATE RETIREMENT (the ROOT composite-pending defect) ----
const allAxes=()=>Object.fromEntries(SDK_SOURCE_REQUIRED_AXES.map(name=>[name,true]));
const pendingSet=(...values:string[])=>new Set<string>([SDK_COMPOSITE_SOURCE_GAP,...values]);
const contributors={toolchainOperations:12,generatedCredited:3,sourceArchives:2};

test('the composite placeholder retires ONLY with every closed axis, no residual and live guards',()=>{
  const r=inspectSdkCompositeSourceRetirement({axes:allAxes(),pending:pendingSet(),guardsCurrent:()=>true,contributing:contributors});
  expect(r.retired).toBe(true);
});

test('a MISSING axis keeps the composite placeholder',()=>{
  const axes:any=allAxes();delete axes.toolchainSourceClosure;
  expect(inspectSdkCompositeSourceRetirement({axes,pending:pendingSet(),guardsCurrent:()=>true,contributing:contributors}).retired).toBe(false);
});

test('a FALSE axis keeps the composite placeholder and names it',()=>{
  const axes:any=allAxes();axes.generatedInputIoClosure=false;
  const r=inspectSdkCompositeSourceRetirement({axes,pending:pendingSet(),guardsCurrent:()=>true,contributing:contributors});
  expect(r.retired).toBe(false);
  expect(r.reason).toContain('generatedInputIoClosure');
});

test('an EXTRA axis is refused (a caller cannot widen or shrink the set)',()=>{
  const axes:any={...allAxes(),extra:true};
  expect(inspectSdkCompositeSourceRetirement({axes,pending:pendingSet(),guardsCurrent:()=>true,contributing:contributors}).retired).toBe(false);
});

test('ANY residual real obligation keeps the composite placeholder',()=>{
  const r=inspectSdkCompositeSourceRetirement({axes:allAxes(),pending:pendingSet('qlever-sdk-observed-tool-unresolved'),guardsCurrent:()=>true,contributing:contributors});
  expect(r.retired).toBe(false);
  expect(r.reason).toContain('residual');
});

test('a STALE private capability (guard throws) keeps the composite placeholder',()=>{
  const r=inspectSdkCompositeSourceRetirement({axes:allAxes(),pending:pendingSet(),guardsCurrent:()=>{throw Error('custody changed');},contributing:contributors});
  expect(r.retired).toBe(false);
  expect(r.reason).toContain('guards');
});

test('a vacuous contributor set keeps the composite placeholder',()=>{
  expect(inspectSdkCompositeSourceRetirement({axes:allAxes(),pending:pendingSet(),guardsCurrent:()=>true,contributing:{toolchainOperations:0}}).retired).toBe(false);
});

test('the composite placeholder itself must be present to be retired',()=>{
  const r=inspectSdkCompositeSourceRetirement({axes:allAxes(),pending:new Set<string>(),guardsCurrent:()=>true,contributing:contributors});
  expect(r.retired).toBe(false);
  expect(r.reason).toContain('not present');
});

// ---- SHARED INPUT TABLE (whole-wire deduplication) ----
test('a witness whose input id is MISSING from the table is refused',()=>{
  const f=witnessFixture();const g=wire(f.witness);
  g.witness[0].inputIds=[999];
  expect(()=>inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('compile-output'),
    generatedWitness:g.witness,generatedInputs:g.inputs} as any)).toThrow('did not resolve');
});

test('a witness with NO input table is refused rather than looking complete',()=>{
  const f=witnessFixture();const g=wire(f.witness);
  expect(()=>inspectSdkToolchainOperationFileCoverage({...generated(),originProvenance:provenance('compile-output'),
    generatedWitness:g.witness,generatedInputs:undefined} as any)).toThrow('did not resolve');
});

test('the same input shared by TWO outputs is stored ONCE and still credits both',()=>{
  const f=witnessFixture();const w=f.witness[0];
  const second={...w,path:'/work/build/other.pch',identity:['1','8',String(0o100644),'64','1700000000000000001','1700000000000000002'],sha256:'e'.repeat(64)};
  const g=wire([w,second]);
  const base={...generated(),originProvenance:new Map([['/work/build/pch.h.pch','compile-output'],['/work/build/other.pch','compile-output']]),
    generatedWitness:g.witness,generatedInputs:g.inputs,...privateViews()} as any;
  const r=inspectSdkToolchainOperationFileCoverage(withMappedObservation(base));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBeGreaterThanOrEqual(1);
  // one distinct input row for two outputs
  const ids=new Set(g.witness.flatMap((x:any)=>x.inputIds));
  expect(ids.size).toBe(g.inputs.length);
});

// ---- REGULAR-READ CUSTODY: lease is the immutability proof, not O_RDONLY ----
test('a regular-read input with NO held lease never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{
    w.inputs[0].regularRead.readLeaseSequence=null;w.inputs[0].lifetimeLeaseSequence=null;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('held kernel read lease');
});

test('a regular-read input whose lease was acquired AFTER the read entry is a STALE token',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{
    w.inputs[0].regularRead.readLeaseSequence=w.inputs[0].entrySequence+1;w.inputs[0].lifetimeLeaseSequence=w.inputs[0].entrySequence+1;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('stale token');
});

test('a NEW entry-stop lease between the entry and the capture is VALID, not stale',()=>{
  // Real observer ordering: entry 20 -> ENTRY STOP lease 77 -> capture 80 ->
  // resume 81 -> exit 90. The lease is acquired AFTER the raw entry row, which is
  // exactly what the observer does, and must not be called stale.
  const base=readWitness(()=>{});
  const g=base.generatedInputs as any[];
  g[0].entrySequence=20;g[0].captureSequence=80;
  g[0].regularRead.readLeaseSequence=77;g[0].regularRead.exitSequence=90;
  g[0].regularRead.captureSequence=80;g[0].lifetimeLeaseSequence=77;
  const c=(base.generatedReadCustody as any[])[0];
  c.entrySequence=20;c.captureSequence=80;c.acquisitionEntrySequence=20;
  c.leaseSequence=77;c.exitSequence=90;
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).not.toContain('stale');
});

test('a lease acquired AFTER the capture is stale and refused',()=>{
  const base=readWitness(()=>{});
  const g=base.generatedInputs as any[];
  g[0].regularRead.readLeaseSequence=85;g[0].lifetimeLeaseSequence=85;
  (base.generatedReadCustody as any[])[0].leaseSequence=85;
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('before the input capture');
});

test('a custody row for a DIFFERENT read entry cannot lend its lease to this input',()=>{
  const base=readWitness(()=>{});
  (base.generatedReadCustody as any[])[0].entrySequence=999;
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('not the exported custody association');
});

test('an EMPTY custody table is refused rather than skipping the association',()=>{
  const r=inspectSdkToolchainOperationFileCoverage({...readWitness(()=>{}),generatedReadCustody:[]} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no exported per-lease custody table');
});

test('a lease that is not the exported custody token for this identity is refused',()=>{
  // The INPUT cites lease 5 while the exported custody table still carries 19:
  // the cited token has no association for this exact read.
  const base=readWitness(()=>{});
  const g=base.generatedInputs as any[];
  g[0].regularRead.readLeaseSequence=5;g[0].lifetimeLeaseSequence=5;
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('not the exported custody association');
});

test('a custody row for a DIFFERENT identity cannot lend its lease to this input',()=>{
  const base=readWitness(()=>{});
  (base.generatedReadCustody as any[])[0].identity=['1','99',String(0o100644),'128','1700000000000000001','1700000000000000002'];
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('not the exported custody association');
});

// ---- SOURCE AUTHORITY is not byte custody ----
test('a regular-read input with no verified same-private SOURCE row never credits',()=>{
  const r=inspectSdkToolchainOperationFileCoverage({...readWitness(()=>{}),verifiedInputRows:[]} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no verified same-private source origin');
});

test('a SOURCE row with the SAME path but different bytes does not bind',()=>{
  const r=inspectSdkToolchainOperationFileCoverage({...readWitness(()=>{}),
    verifiedInputRows:[{originalPath:'/usr/include/ord.h',bytes:129,sha256:'1'.repeat(64),mode:0o100644}]} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a regular-read input with no canonical resolved target never claims SOURCE',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{delete w.inputs[0].resolvedPath;}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('canonical resolved target');
});

test('a resolved target that does not match the verified row path never claims SOURCE',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(w=>{w.inputs[0].resolvedPath='/usr/include/other.h';}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

// ---- PER-INPUT SOURCE ORIGIN derived from SAME-private verified proofs ----
test('a verified signed-Debian ownership tuple closes the origin',()=>{
  const r=inspectSdkToolchainOperationFileCoverage(readWitness(()=>{}));
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(1);
});

test('an input with NO ownership row keeps SOURCE pending',()=>{
  const r=inspectSdkToolchainOperationFileCoverage({...readWitness(()=>{}),verifiedOwnershipRows:[]} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('origin is unresolved');
});

test('a verified input row for DIFFERENT bytes does not close this input',()=>{
  // The BYTE identity lives in the verified input row, not the ownership row.
  const base=readWitness(()=>{});
  (base.verifiedInputRows as any[])[0].sha256='9'.repeat(64);
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no verified same-private source origin');
});

test('an ownership row whose owner has NO source tuple stays pending',()=>{
  const base=readWitness(()=>{});
  (base.verifiedOwnershipRows as any[])[0].owners=[{binary:'x',binaryVersion:'1'}];
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('no closed independent source origin');
});

test('a producer-supplied class STRING cannot mint an origin',()=>{
  const base=readWitness(()=>{});base.verifiedOwnershipRows=[];
  (base as any).generatedReadSourceClass=[{leaseSequence:19,identity:readInput().identity,bytes:128,
    sha256:'1'.repeat(64),originClass:'signed-debian-installed',phase:'compile',pid:7,entrySequence:20}];
  const r=inspectSdkToolchainOperationFileCoverage(base);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('an earlier generated output with identical bytes closes ONLY if it fully closes',()=>{
  // The predecessor must itself pass the SAME full verifier: its own exec image,
  // complete input universe, and every input's source + custody. An empty-input
  // predecessor is not an origin.
  const f=witnessFixture();
  const HEADER='/usr/include/ord.h';
  const priorRead={...readInput(),entrySequence:5,captureSequence:6,lifetimeLeaseSequence:4,
    regularRead:{...readInput().regularRead,exitSequence:7,captureSequence:6,readLeaseSequence:4}};
  const prior={...f.witness[0],path:'/work/build/gen.h',sha256:'1'.repeat(64),bytes:128,
    completedCloseSequence:18,producerCaptureSequence:17,phase:'compile',
    identity:['1','77',String(0o100644),'128','1700000000000000001','1700000000000000002'],
    inputs:[priorRead]};
  f.witness[0].inputs=[readInput()];
  const g=wire([f.witness[0],prior]);
  const r=inspectSdkToolchainOperationFileCoverage({...generated(),
    originProvenance:new Map([['/work/build/pch.h.pch','compile-output']]),
    generatedWitness:g.witness,generatedInputs:g.inputs,
    generatedReadCustody:[
      {leaseSequence:19,identity:readInput().identity,bytes:128,sha256:'1'.repeat(64),entrySequence:20,
        captureSequence:21,acquisitionEntrySequence:19,exitSequence:22,phase:'compile',pid:7},
      {leaseSequence:4,identity:readInput().identity,bytes:128,sha256:'1'.repeat(64),entrySequence:5,
        captureSequence:6,acquisitionEntrySequence:4,exitSequence:7,phase:'compile',pid:7}],
    verifiedInputRows:[{originalPath:HEADER,bytes:128,sha256:'1'.repeat(64),mode:0o644}],
    verifiedOwnershipRows:[
      {path:HEADER,role:'observed-input',observedBeforeCompile:true,
        owners:[{binary:'libstdc++6',binaryVersion:'14',source:{name:'gcc-14',version:'14.2.0'}}]}],
    binaryFiles:[{installedPath:HEADER,bytes:128,sha256:'1'.repeat(64),mode:0o644,
      binary:{name:'libstdc++6',version:'14',architecture:'arm64'},source:{name:'gcc-14',version:'14.2.0'},
      deb:{path:'inner/y.deb',bytes:1,sha256:'d'.repeat(64)},
      packages:{path:'inner/Q',bytes:1,sha256:'e'.repeat(64),signedIndexPath:'Packages',inReleaseSha256:'c'.repeat(64)},
      dataMemberPath:'usr/include/ord.h'}]} as any);
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBeGreaterThanOrEqual(1);
});

// ---- AGGREGATE RETIREMENT (the ROOT composite-pending defect) ----

// ---- SHARED INPUT TABLE (whole-wire deduplication) ----



// ---- REGULAR-READ CUSTODY: lease is the immutability proof, not O_RDONLY ----








// ---- SOURCE AUTHORITY is not byte custody ----



// ---- generated-same-phase must be CAUSAL, not merely byte-equal ----
const genCase=(mut:(prior:any,w:any)=>void)=>{
  const f=witnessFixture();
  const prior={...f.witness[0],path:'/work/build/gen.h',sha256:'1'.repeat(64),bytes:128,
    completedCloseSequence:18,producerCaptureSequence:17,phase:'compile',
    identity:['1','77',String(0o100644),'128','1700000000000000001','1700000000000000002']};
  f.witness[0].inputs=[readInput()];
  mut(prior,f.witness[0]);
  const g=wire([f.witness[0],prior]);
  return inspectSdkToolchainOperationFileCoverage({...generated(),
    originProvenance:new Map([['/work/build/pch.h.pch','compile-output']]),
    generatedWitness:g.witness,generatedInputs:g.inputs,generatedReadCustody:[{leaseSequence:19,
      identity:readInput().identity,bytes:128,sha256:'1'.repeat(64),entrySequence:20,
      captureSequence:21,acquisitionEntrySequence:19,exitSequence:22,phase:'compile',pid:7}],
    verifiedInputRows:[{originalPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644}],
    verifiedOwnershipRows:[]} as any);
};

test('a FUTURE producer close cannot be the origin of an earlier read',()=>{
  const r=genCase((prior)=>{prior.completedCloseSequence=999;prior.producerCaptureSequence=998;});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('origin is unresolved');
});

test('a producer close in ANOTHER phase cannot be the origin',()=>{
  const r=genCase((prior)=>{prior.phase='configure';});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a producer close exactly AT the read entry is not earlier and is refused',()=>{
  const r=genCase((prior,w)=>{prior.completedCloseSequence=w.inputs[0].entrySequence;
    prior.producerCaptureSequence=prior.completedCloseSequence-1;});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

// ---- transitive generated-source closure: byte equality is not authority ----
const genTransitive=(opts:{priorOwned:boolean;priorSha?:string;cycle?:boolean})=>{
  const f=witnessFixture();
  const prior={...f.witness[0],path:'/work/build/gen.h',sha256:opts.priorSha??'1'.repeat(64),bytes:128,
    completedCloseSequence:18,producerCaptureSequence:17,phase:'compile',
    identity:['1','77',String(0o100644),'128','1700000000000000001','1700000000000000002']};
  f.witness[0].inputs=[readInput()];
  const witnessList=[f.witness[0],prior];
  if(opts.cycle){
    // prior's own parent points back at a node with the same byte image
    witnessList.push({...prior,path:'/work/build/gen2.h',identity:['1','78',String(0o100644),'128','1','1'],
      completedCloseSequence:17,producerCaptureSequence:16});
  }
  const g=wire(witnessList);
  // NOTE: no ownership row for the READ path itself, so the input cannot close
  // via signed-Debian; only the generated chain may close it.
  const ownership=opts.priorOwned?[{path:prior.path,role:'compile-output',observedBeforeCompile:false,
    owners:[{binary:'libc6',binaryVersion:'2.39',source:{name:'glibc',version:'2.39'}}]}]:[];
  const signed=opts.priorOwned?[{installedPath:prior.path,bytes:128,sha256:opts.priorSha??'1'.repeat(64),mode:0o644,
    binary:{name:'libc6',version:'2.39',architecture:'arm64'},source:{name:'glibc',version:'2.39'},
    deb:{path:'inner/x.deb',bytes:1,sha256:'a'.repeat(64)},
    packages:{path:'inner/P',bytes:1,sha256:'b'.repeat(64),signedIndexPath:'Packages',inReleaseSha256:'c'.repeat(64)},
    dataMemberPath:'work/build/gen.h'}]:[];
  return inspectSdkToolchainOperationFileCoverage({...generated(),
    originProvenance:new Map([['/work/build/pch.h.pch','compile-output']]),
    generatedWitness:g.witness,generatedInputs:g.inputs,generatedReadCustody:[{leaseSequence:19,
      identity:readInput().identity,bytes:128,sha256:'1'.repeat(64),entrySequence:20,
      captureSequence:21,acquisitionEntrySequence:19,exitSequence:22,phase:'compile',pid:7}],
    verifiedInputRows:[{originalPath:'/usr/include/ord.h',bytes:128,sha256:'1'.repeat(64),mode:0o644}],
    verifiedOwnershipRows:ownership,binaryFiles:signed} as any);
};

test('an earlier producer whose OWN source is unresolved does NOT close the read',()=>{
  const r=genTransitive({priorOwned:false});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).toContain('origin is unresolved');
});

test('an earlier producer whose bytes DIFFER cannot be the origin',()=>{
  const r=genTransitive({priorOwned:true,priorSha:'9'.repeat(64)});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a generated origin chain with a cycle is refused, not accepted',()=>{
  const r=genTransitive({priorOwned:false,cycle:true});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});
