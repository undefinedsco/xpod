/** REAL transitive generated-source closure over the ACTUAL verifier.
 *
 * Each case drives `inspectSdkToolchainOperationFileCoverage`, which is the same
 * function the operational leaf calls. Predecessor nodes are real witnesses with
 * their own exec image, input universe and per-input source/custody, and the
 * recursion follows the ACTUAL input edges (input identity + exact bytes).
 */
import {test, expect} from 'bun:test';
import {inspectSdkToolchainOperationFileCoverage} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';

const HEADER='/usr/include/ord.h';
const sha=(c:string)=>c.repeat(64);
const inputIdentity=(n:number)=>['1',String(20+n),String(0o100644),'64','1700000000000000001','1700000000000000002'];
const outIdentity=(n:number)=>['1',String(900+n),String(0o100644),'8','1700000000000000001','1700000000000000002'];
const outBytes=()=>8;

const readEdge=(n:number)=>({entrySequence:10+n,captureSequence:11+n,identity:inputIdentity(n),
  bytes:64,sha256:sha('a'),protection:1,flags:0,lifetimeLeaseSequence:9+n,executable:false,
  inputModel:'regular-read',resolvedPath:HEADER,
  regularRead:{form:'pread64' as const,fd:3,rangeStart:0,consumedLength:64,result:64,exitSequence:12+n,
    captureSequence:11+n,generation:{identity:inputIdentity(n),flags:0,position:0},iovcnt:null,
    iovLengths:null,readLeaseSequence:9+n}});

const witness=(n:number,over:any={})=>({path:'/out/build/w'+n+'.o',bytes:8,sha256:sha(String(n%10)),
  identity:outIdentity(n),phase:'compile',producerPid:40+n,completedCloseSequence:100+n,
  producerCaptureSequence:99+n,inputComplete:true,readOperations:0,inputObligationCount:1,
  readInputCount:1,mappingInputCount:0,
  execImage:{pid:40+n,phase:'compile',exe:'/usr/bin/clang++-19',
    identity:['1',String(500+n),String(0o100755),'1','1700000000000000001','1700000000000000002'],
    bytes:1,sha256:sha('e')},
  ...over});

const custody=(n:number)=>({leaseSequence:9+n,identity:inputIdentity(n),bytes:64,sha256:sha('a'),
  entrySequence:10+n,captureSequence:11+n,acquisitionEntrySequence:10+n,exitSequence:12+n,
  phase:'compile',pid:40+n});

/** Coverage that actually MAPS the consumer output, so the leaf's join() runs the
 * real verifier for it (otherwise nothing is evaluated at all). */
const coverage=(consumer:any)=>({schemaVersion:1,operations:[{
  kind:'exec',phase:'compile',pid:999,entrySequence:1,execEventSequence:2,captureSequence:3,
  primaryFile:{observedPath:'/usr/bin/cc',identityDecimal:['1','2',String(0o100755),'4096','1','1'],
    original:{path:'capture-0001.original',bytes:4096,sha256:sha('c')},originalCaptureSequence:4},
  elf:{machine:183},
  mapOriginals:consumer===undefined?[]:[{
    observedPath:consumer.path,identityDecimal:consumer.identity,original:{
      path:'capture-0010.original',bytes:Number(consumer.identity[3]),sha256:consumer.sha256},
    originalCaptureSequence:10,captureSequence:10,
    mapping:{startHex:'1000',endHex:'1010',path:consumer.path,
      inode:Number(consumer.identity[1]),deviceMajor:0,deviceMinor:1,fileOffset:0,permissions:'r--p'}}],
  expectedFileMappingCount:consumer===undefined?0:1,unresolved:[]}],pending:[]});

/** Build the shared input table + per-output inputIds from the witnesses' own
 * input edges, so the harness mirrors the real transport exactly. */
const run=(witnesses:readonly any[],over:any={})=>{
  const table:any[]=[];const index=new Map<string,number>();
  const resolve=(edge:any)=>{
    const key=JSON.stringify([edge.identity,edge.bytes,edge.sha256,edge.entrySequence,edge.captureSequence]);
    const found=index.get(key);if(found!==undefined)return found;
    const id=table.length;index.set(key,id);table.push({...edge,inputId:id});return id;
  };
  const rows=witnesses.map((w:any)=>({...w,inputIds:(w.inputs??[]).map(resolve)}));
  // The FIRST witness is the consumer under test; join it for real.
  const consumerForJoin=witnesses[0];
  return inspectSdkToolchainOperationFileCoverage({
    coverage:coverage(consumerForJoin),
    observedFiles:consumerForJoin===undefined?[]:[{path:consumerForJoin.path,phase:'compile',
      captureSequence:10,bytes:Number(consumerForJoin.identity[3]),
      sha256:consumerForJoin.sha256,mode:0o644,identityDecimal:consumerForJoin.identity}],
    afterRows:consumerForJoin===undefined?[]:[{originalPath:consumerForJoin.path,
      bytes:Number(consumerForJoin.identity[3]),sha256:consumerForJoin.sha256,mode:0o644}],
    originProvenance:new Map(witnesses.map((w:any)=>[w.path,'compile-output'])),
    generatedWitness:rows as any,generatedInputs:table,
    generatedReadCustody:(over.generatedReadCustody??witnesses.map((w:any,index:number)=>custody(w.__n??index))),
    verifiedInputRows:[{originalPath:HEADER,bytes:64,sha256:sha('a'),mode:0o644}],
    verifiedOwnershipRows:[{path:HEADER,role:'observed-input',observedBeforeCompile:true,
      owners:[{binary:'libstdc++6',binaryVersion:'14',source:{name:'gcc-14',version:'14.2.0'}}]}],
    binaryFiles:[{installedPath:HEADER,bytes:64,sha256:sha('a'),mode:0o644,
      binary:{name:'libstdc++6',version:'14',architecture:'arm64'},source:{name:'gcc-14',version:'14.2.0'},
      deb:{path:'inner/y.deb',bytes:1,sha256:sha('d')},
      packages:{path:'inner/Q',bytes:1,sha256:sha('e'),signedIndexPath:'Packages',inReleaseSha256:sha('c')},
      dataMemberPath:'usr/include/ord.h'}],
    ...over} as any);
};

/** A predecessor that produces the consumer's INPUT object. */
const predecessor=(n:number,over:any={})=>{
  const base=witness(n,over);
  // The predecessor's OWN read must precede ITS completed close.
  const own={...readEdge(n),entrySequence:2,captureSequence:3,lifetimeLeaseSequence:1,
    regularRead:{...readEdge(n).regularRead,exitSequence:4,captureSequence:3,readLeaseSequence:1}};
  return {...base,path:'/out/build/prev.h',bytes:64,sha256:sha('a'),identity:inputIdentity(0),
    completedCloseSequence:9,producerCaptureSequence:8,
    inputs:[own],__n:n};
};

test('a fully closing predecessor chain credits the consumer (real input edges)',()=>{
  const prior=predecessor(1);
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:prior.identity,bytes:64,sha256:sha('a'),
    entrySequence:20,captureSequence:21,regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,prior],{generatedReadCustody:[custody(0),
    {...custody(1),leaseSequence:1,identity:inputIdentity(1),entrySequence:2,captureSequence:3,
      acquisitionEntrySequence:2,exitSequence:4}]});
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).not.toContain('origin is unresolved');
});

test('a predecessor with a BAD exec image cannot close the consumer',()=>{
  const prior=predecessor(1,{execImage:null});
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:prior.identity,bytes:64,sha256:sha('a'),
    entrySequence:20,captureSequence:21,regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,prior],{generatedReadCustody:[custody(0),
    {...custody(1),leaseSequence:1,identity:inputIdentity(1),entrySequence:2,captureSequence:3,
      acquisitionEntrySequence:2,exitSequence:4}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
});

test('a predecessor with an INCOMPLETE input universe cannot close the consumer',()=>{
  const prior=predecessor(1,{inputComplete:false,readOperations:3});
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:prior.identity,bytes:64,sha256:sha('a'),
    entrySequence:20,captureSequence:21,regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,prior],{generatedReadCustody:[custody(0),
    {...custody(1),leaseSequence:1,identity:inputIdentity(1),entrySequence:2,captureSequence:3,
      acquisitionEntrySequence:2,exitSequence:4}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
});

test('a predecessor whose owner tuple MISMATCHES its signed binary cannot close',()=>{
  const prior=predecessor(1);
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:prior.identity,bytes:64,sha256:sha('a'),
    entrySequence:20,captureSequence:21,regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,prior],{generatedReadCustody:[custody(0),{...custody(1),identity:prior.identity}],
    verifiedOwnershipRows:[{path:HEADER,role:'observed-input',observedBeforeCompile:true,
      owners:[{binary:'libstdc++6',binaryVersion:'14',source:{name:'gcc-14',version:'14.2.0'}}]}],
    binaryFiles:[{installedPath:HEADER,bytes:64,sha256:sha('f'),mode:0o644,
      binary:{name:'libstdc++6',version:'14',architecture:'arm64'},source:{name:'gcc-14',version:'14.2.0'},
      deb:{path:'inner/y.deb',bytes:1,sha256:sha('d')},
      packages:{path:'inner/Q',bytes:1,sha256:sha('e'),signedIndexPath:'Packages',inReleaseSha256:sha('c')},
      dataMemberPath:'usr/include/ord.h'}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
});

test('a predecessor CYCLE is refused, not accepted',()=>{
  const a={...predecessor(1),path:'/out/build/a.h',identity:inputIdentity(0)};
  const b={...predecessor(2),path:'/out/build/b.h',identity:inputIdentity(0),
    completedCloseSequence:9};
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:a.identity,bytes:64,sha256:sha('a'),
    entrySequence:20,captureSequence:21,regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,a,b],{generatedReadCustody:[custody(0),{...custody(1),identity:a.identity},{...custody(2),identity:b.identity}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
  expect(r.facts.sdkToolchainGeneratedProducerSourceVerified).toBe(false);
});

test('a valid 20-node predecessor chain is NOT rejected by any depth cap',()=>{
  // Each node's input is produced by the next; the tail closes on a real signed
  // tuple. The graph is finite, so recursion must be bounded by nodes, not a
  // hand-picked depth constant.
  const chain:any[]=[];
  const N=20;
  for(let i=0;i<N;i++){
    const identity= i===0?inputIdentity(0):['1',String(7000+i),String(0o100644),'64','1','1'];
    const inputFor= i+1<N?['1',String(7000+i+1),String(0o100644),'64','1','1']:inputIdentity(90+i);
    chain.push({path:'/out/build/c'+i+'.h',bytes:64,sha256:sha('a'),identity,
      phase:'compile',producerPid:60+i,completedCloseSequence:200+i,producerCaptureSequence:190+i,
      inputComplete:true,readOperations:0,inputObligationCount:1,readInputCount:1,mappingInputCount:0,
      execImage:{pid:60+i,phase:'compile',exe:'/usr/bin/clang++-19',
        identity:['1',String(800+i),String(0o100755),'1','1','1'],bytes:1,sha256:sha('e')},
      inputs:[{...readEdge(i),identity:inputFor,bytes:64,sha256:i+1<N?sha('a'):sha('a'),
        entrySequence:10, captureSequence:11,
        regularRead:{...readEdge(i).regularRead,exitSequence:12,captureSequence:11}}],
      __n:i});
  }
  const consumer={...witness(0),inputs:[{...readEdge(0),identity:chain[0].identity,
    entrySequence:20,captureSequence:21,
    regularRead:{...readEdge(0).regularRead,exitSequence:22,captureSequence:21}}],__n:0};
  const r=run([consumer,...chain],{generatedReadCustody:[custody(0),
    ...chain.map((c:any,i:number)=>({...custody(i),identity:c.identity,entrySequence:10,
      captureSequence:11,acquisitionEntrySequence:10,exitSequence:12,phase:'compile',pid:60+i}))]});
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).not.toContain('depth');
});

// ---- direct (non-generated) origin branches, through the real join ----
const directRun=(over:any)=>run([{...witness(0),inputs:[readEdge(0)],__n:0}],over);

test('a reviewed Git postpatch member closes via the VERIFIED source root',()=>{
  const r=directRun({verifiedOwnershipRows:[],
    verifiedGitSourceRoot:'/opt/qlever-sdk/source',
    verifiedGitPostpatchMembers:[{path:'usr/include/ord.h',mode:0o644,bytes:64,sha256:sha('a')}],
    binaryFiles:[],
    verifiedInputRows:[{originalPath:'/opt/qlever-sdk/source/usr/include/ord.h',bytes:64,sha256:sha('a'),mode:0o644}]});
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).not.toContain('origin is unresolved');
});

test('a Git member at the WRONG canonical path does not close',()=>{
  const r=directRun({verifiedOwnershipRows:[],
    verifiedGitSourceRoot:'/opt/qlever-sdk/source',
    verifiedGitPostpatchMembers:[{path:'other/include/ord.h',mode:0o644,bytes:64,sha256:sha('a')}],
    binaryFiles:[],
    verifiedInputRows:[{originalPath:'/opt/qlever-sdk/source/usr/include/ord.h',bytes:64,sha256:sha('a'),mode:0o644}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a Git member with DIFFERENT bytes does not close',()=>{
  const r=directRun({verifiedOwnershipRows:[],
    verifiedGitSourceRoot:'/opt/qlever-sdk/source',
    verifiedGitPostpatchMembers:[{path:'usr/include/ord.h',mode:0o644,bytes:64,sha256:sha('b')}],
    binaryFiles:[],
    verifiedInputRows:[{originalPath:'/opt/qlever-sdk/source/usr/include/ord.h',bytes:64,sha256:sha('a'),mode:0o644}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});

test('a prepared dependency byte row closes with exact bytes',()=>{
  const r=directRun({verifiedOwnershipRows:[],binaryFiles:[],verifiedGitPostpatchMembers:[],
    verifiedPreparedByteRows:[{path:HEADER,bytes:64,sha256:sha('a'),mode:0o644}]});
  expect(r.facts.sdkToolchainGeneratedProducerPending.join(' ')).not.toContain('origin is unresolved');
});

test('a prepared row with DIFFERENT bytes does not close',()=>{
  const r=directRun({verifiedOwnershipRows:[],binaryFiles:[],verifiedGitPostpatchMembers:[],
    verifiedPreparedByteRows:[{path:HEADER,bytes:64,sha256:sha('f'),mode:0o644}]});
  expect(r.facts.sdkToolchainGeneratedProducerCreditedCount).toBe(0);
});
