import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView} from './qlever-sdk-originals';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {sdkVerifiedInputOriginalView,sdkVerifiedSourceArchiveOriginalView} from './qlever-sdk-source';
import {qleverSdkExecutionOriginalObservation} from './qlever-sdk-generation';
import {qleverSdkDebianBinaryObservation,type DebianInstalledBinaryFile} from './qlever-sdk-debian-binary';
import {qleverSdkDebianIndexObservation} from './qlever-sdk-debian-index';
import {qleverSdkDebianSignatureObservation} from './qlever-sdk-debian-signature';
import {observeQleverSdkObservedToolOriginals} from './qlever-sdk-observed-tools';
import {qleverSdkUpstreamGitObservation} from './qlever-sdk-upstream-source';
import {qleverSdkFetchContentByteRows} from './qlever-sdk-fetchcontent';

function need(value:unknown,reason:string):asserts value {if(!value)throw Error('SDK toolchain coverage: '+reason);}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const decimalIdentity=(value:unknown):value is readonly string[]=>Array.isArray(value)&&value.length===6&&value.every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(part)&&BigInt(part)<=0xffffffffffffffffn);
const absolute=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('/')&&!/[\x00-\x1f\x7f\\]/u.test(value)&&value.split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');
/** Decode one independently replayed operation at a time. No whole expanded
 * copy is retained, and v1 keeps its original representation and limits. */
export function* sdkToolchainOperations(coverage:any,check:()=>void=()=>{}):Generator<any> {
  need(coverage&&(coverage.schemaVersion===1||coverage.schemaVersion===2)&&Array.isArray(coverage.operations)&&coverage.operations.length<=limits.sourceMembers,'known bounded tool operation layout required');
  need(Buffer.byteLength(JSON.stringify(coverage))<=limits.metadataBytes,'bounded operation projection required');
  if(coverage.schemaVersion===1){for(const operation of coverage.operations){check();yield operation;}return;}
  need(coverage.model==='indexed-tool-operation-coverage-v1'&&Array.isArray(coverage.paths)&&coverage.paths.length<=limits.sourceMembers,'known indexed tool operation model required');
  const paths=coverage.paths as unknown[];
  need(paths.every(absolute)&&new Set(paths).size===paths.length,'unique absolute indexed mapping paths required');
  for(const row of coverage.operations){
    check();need(Array.isArray(row)&&row.length===11&&['exec','mmap','protect'].includes(row[0])&&typeof row[1]==='string'&&row[1].length>0&&row[1].length<=64&&[row[2],row[3],row[4],row[6]].every(positive)&&Number.isSafeInteger(row[5])&&row[5]>=0&&Array.isArray(row[9])&&Array.isArray(row[10])&&row[9].length+row[10].length===row[5],'exact indexed operation fields required');
    need(row[0]==='exec'?row[7]&&row[8]:row[7]===null&&row[8]===null,'indexed operation role fields differ');
    const missing=new Set<string>();
    const unresolved=row[10].map((mapping:any)=>{
      need(Array.isArray(mapping)&&mapping.length===9&&mapping.slice(0,2).every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9a-f][0-9a-f]*)$/u.test(part))&&BigInt('0x'+mapping[0])<BigInt('0x'+mapping[1])&&typeof mapping[2]==='string'&&/^[r-][w-][x-][ps]$/u.test(mapping[2])&&[mapping[3],mapping[6]].every((part:unknown)=>typeof part==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(part)&&BigInt(part)<=0xffffffffffffffffn)&&BigInt(mapping[6])>0&&mapping.slice(4,6).every((part:unknown)=>Number.isSafeInteger(part)&&Number(part)>=0)&&Number.isSafeInteger(mapping[7])&&mapping[7]>=0&&mapping[7]<paths.length&&(mapping[8]===null||positive(mapping[8])),'complete indexed missing mapping fields required');
      const key=JSON.stringify(mapping);need(!missing.has(key),'duplicate indexed missing VMA');missing.add(key);
      return 'toolchain-operation-file-mapping-original-unavailable:'+row[4]+':'+paths[mapping[7]]+':'+mapping[0]+'-'+mapping[1]+':'+mapping[3];
    });
    yield {kind:row[0],phase:row[1],pid:row[2],entrySequence:row[3],captureSequence:row[4],expectedFileMappingCount:row[5],...(row[0]==='exec'?{execEventSequence:row[6],primaryFile:row[7],elf:row[8]}:{exitSequence:row[6]}),mapOriginals:row[9],unresolved};
  }
}
/** Pure diagnostic join. Calling it with JSON never registers any capability. */
/** Pure transport decode for the indexed generated-producer wire. No capability.
 *
 * The scanner no longer inlines per-output input records; it emits one closed,
 * versioned transport (shared SOURCE rows + columnar per-READ rows + per-OUTPUT
 * references + the two per-lease evidence tables). This re-expands it into the
 * exact shapes the verifier already validates, so every downstream guard --
 * missing/extra/future/self edge, currentness, custody -- runs unchanged.
 *
 * A malformed transport returns `undefined`; the caller treats that as an
 * unusable witness rather than silently narrowing the input universe.
 */
const TRANSPORT_MODEL = 'indexed-generated-producer-transport-v2';
const TRANSPORT_READ_FIELDS = ['sourceId', 'entrySequence', 'captureSequence', 'inputModel',
  'lifetimeLeaseSequence', 'protection', 'flags', 'executable', 'form', 'fd',
  'readLeaseSequence', 'rangeStart', 'consumedLength', 'result', 'exitSequence',
  'iovcnt', 'iovLengths'] as const;
const TRANSPORT_CUSTODY_FIELDS = ['leaseSequence', 'identity', 'bytes', 'sha256', 'entrySequence',
  'captureSequence', 'acquisitionEntrySequence', 'exitSequence', 'phase', 'model'] as const;
const TRANSPORT_SOURCECLASS_FIELDS = ['leaseSequence', 'identity', 'bytes', 'sha256', 'resolvedPath',
  'originClass', 'originDetail', 'phase'] as const;

/** Decode ONE carried column. Two forms are accepted and both are lossless:
 *  * `raw`  -- the column IS the per-row values (v1 shape);
 *  * `dict` -- a distinct-value dictionary plus one index per row.
 * A damaged/foreign/out-of-range index REFUSES rather than narrowing.
 */
const transportColumn = (column:any,count:number):any[]|undefined => {
  if(Array.isArray(column))return column.length===count?column.slice():undefined;
  if(!column||typeof column!=='object')return undefined;
  const values=column.values;
  if(!Array.isArray(values))return undefined;
  if(column.form==='raw')return values.length===count?values.slice():undefined;
  if(column.form!=='dict')return undefined;
  const codes=column.codes;
  if(!Array.isArray(codes)||codes.length!==count)return undefined;
  const out:any[]=[];
  for(const code of codes){
    if(!Number.isSafeInteger(code)||code<0||code>=values.length)return undefined;
    out.push(values[code]);
  }
  return out;
};

/** Decode an extras slot: absent list, legacy list, dictionary, or the
 * field-keyed form the Python encoder emits for uniform key sets. */
const transportExtras = (encoded:any,count:number):any[]|undefined => {
  const extras=encoded===undefined||encoded===null?undefined:encoded;
  if(extras===undefined)return new Array(count).fill(undefined);
  if(Array.isArray(extras))return extras.length===count?extras.slice():undefined;
  if(extras&&typeof extras==='object'&&extras.form==='fields'){
    const keys=extras.keys, columns=extras.columns;
    if(!Array.isArray(keys)||!Array.isArray(columns)||columns.length!==keys.length)return undefined;
    const decoded:any[]=[];
    for(const column of columns){
      const values=transportColumn(column,count);if(values===undefined)return undefined;
      decoded.push(values);
    }
    const rows:any[]=[];
    for(let position=0;position<count;position++){
      const row:any={};
      for(let i=0;i<keys.length;i++)row[keys[i]]=decoded[i][position];
      rows.push(row);
    }
    return rows;
  }
  return transportColumn(extras,count);
};

const transportRows = (encoded:any, fields:readonly string[]):any[]|undefined => {
  if(encoded===undefined||encoded===null)return [];
  if(!encoded||typeof encoded!=='object')return undefined;
  const layout=encoded.layout, columns=encoded.columns, count=encoded.count;
  if(!Array.isArray(layout)||layout.length!==fields.length
     ||!layout.every((name:string,index:number)=>name===fields[index]))return undefined;
  if(!Array.isArray(columns)||columns.length!==fields.length)return undefined;
  if(!Number.isSafeInteger(count)||count<0)return undefined;
  const decoded:any[]=[];
  for(const column of columns){
    const values=transportColumn(column,count);if(values===undefined)return undefined;
    decoded.push(values);
  }
  const extras=transportExtras(encoded.extras,count);
  if(extras===undefined)return undefined;
  const rows:any[]=[];
  for(let position=0;position<count;position++){
    let row:any;
    if(extras[position]===undefined||extras[position]===null)row={};
    else if(extras[position]&&typeof extras[position]==='object'&&!Array.isArray(extras[position]))row={...extras[position]};
    else return undefined;
    for(let index=0;index<fields.length;index++)row[fields[index]]=decoded[index][position];
    rows.push(row);
  }
  return rows;
};

export const decodeGeneratedProducerTransport = (value:any):Readonly<{
  inputs:readonly any[];witness:readonly any[];graph:any;
  custody:readonly any[];sourceClass:readonly any[];
}>|undefined => {
  if(!value||typeof value!=='object'||value.model!==TRANSPORT_MODEL||value.schemaVersion!==2)return undefined;
  const sources=value.sources, outputs=value.outputs;
  if(!Array.isArray(sources)||!Array.isArray(outputs))return undefined;
  if(value.sourceCount!==sources.length||value.outputCount!==outputs.length)return undefined;
  const readCount=value.readCount;
  if(!Number.isSafeInteger(readCount)||readCount<0)return undefined;
  const layout=value.readLayout, columns=value.readColumns;
  if(!Array.isArray(layout)||layout.length!==TRANSPORT_READ_FIELDS.length
     ||!layout.every((name:string,index:number)=>name===TRANSPORT_READ_FIELDS[index]))return undefined;
  if(!Array.isArray(columns)||columns.length!==TRANSPORT_READ_FIELDS.length)return undefined;
  const readColumns:any[]=[];
  for(const column of columns){
    const decoded=transportColumn(column,readCount);if(decoded===undefined)return undefined;
    readColumns.push(decoded);
  }
  // `readExtras` keeps its LEGACY meaning: the unknowns of each read's
  // `regularRead` object. `inputExtras` is the separate OPTIONAL slot for the
  // unknown TOP-LEVEL input fields of that same read. Two independent lists mean
  // a field NAME may collide between the scopes without either value winning.
  const readExtras=transportExtras(value.readExtras,readCount);
  if(readExtras===undefined)return undefined;
  const inputExtras=transportExtras(value.inputExtras,readCount);
  if(inputExtras===undefined)return undefined;

  const bySource=new Map<number,any>();
  for(let index=0;index<sources.length;index++){
    const source=sources[index];
    if(!source||typeof source!=='object'||source.sourceId!==index||bySource.has(index))return undefined;
    bySource.set(index,source);
  }
  const reads:any[]=[];
  for(let position=0;position<readCount;position++){
    const read:any={};
    for(let index=0;index<TRANSPORT_READ_FIELDS.length;index++)read[TRANSPORT_READ_FIELDS[index]]=readColumns[index][position];
    if(!Number.isSafeInteger(read.sourceId)||!bySource.has(read.sourceId))return undefined;
    reads.push(read);
  }

  // Re-expand the compact graph (edges are `[inputNodeId, readId]`); every other
  // edge field comes from its own read row so the graph cannot disagree.
  const graph=value.graph&&typeof value.graph==='object'?value.graph:undefined;
  let expandedGraph:any=graph;
  if(graph&&graph.model==='compact-deduplicated-causal-graph-v2'){
    const nodes=Array.isArray(graph.nodes)?graph.nodes:[];
    const index=new Map<string,number>();
    for(const node of nodes){
      if(!node||node.model==='output')continue;
      const key=[node.model,String(node.bytes),node.sha256,(node.identity??[]).map(String).join(',')].join('\u0000');
      if(index.has(key)&&index.get(key)!==node.nodeId)return undefined;
      index.set(key,node.nodeId);
    }
    const sets:any[]=[];
    for(const entry of (Array.isArray(graph.inputSets)?graph.inputSets:[])){
      if(!entry||!Array.isArray(entry.readIds))return undefined;
      const edges:any[]=[];
      for(const readId of entry.readIds){
        if(!Number.isSafeInteger(readId)||readId<0||readId>=reads.length)return undefined;
        const read=reads[readId],source=bySource.get(read.sourceId);
        const key=[read.inputModel,String(source.bytes),source.sha256,(source.identity??[]).map(String).join(',')].join('\u0000');
        const nodeId=index.get(key);
        if(nodeId===undefined)return undefined;
        edges.push([nodeId,read.entrySequence,read.captureSequence,read.inputModel,
          read.lifetimeLeaseSequence,read.form,read.fd,read.rangeStart,read.consumedLength,
          read.result,read.exitSequence]);
      }
      sets.push({setId:entry.setId,edges});
    }
    expandedGraph={...graph,model:'compact-deduplicated-causal-graph-v1',
      edgeLayout:['inputNodeId','entrySequence','captureSequence','inputModel','lifetimeLeaseSequence',
        'readForm','readFd','readRangeStart','readConsumedLength','readResult','readExitSequence'],
      inputSets:sets};
  }

  const inputs:any[]=[];
  for(let readId=0;readId<reads.length;readId++){
    const read=reads[readId],source=bySource.get(read.sourceId);
    // TWO INDEPENDENT SLOTS, exactly as the encoder wrote them:
    //   readExtras  -> the unknowns of this read's `regularRead` (legacy meaning)
    //   inputExtras -> the unknowns of this read's TOP-LEVEL input record
    // Neither is a reserved key, so a field NAME colliding across the two scopes
    // keeps both values. Source-level extras stay supported for old transports.
    const nestedExtra=readExtras[readId];
    if(nestedExtra!==undefined&&(nestedExtra===null||typeof nestedExtra!=='object'||Array.isArray(nestedExtra)))return undefined;
    const topExtra=inputExtras[readId];
    if(topExtra!==undefined&&(topExtra===null||typeof topExtra!=='object'||Array.isArray(topExtra)))return undefined;
    const sourceExtra=source.extra;
    if(sourceExtra!==undefined&&(sourceExtra===null||typeof sourceExtra!=='object'||Array.isArray(sourceExtra)))return undefined;
    const row:any={...(sourceExtra??{}),...(topExtra??{})};
    row.inputId=readId;row.entrySequence=read.entrySequence;row.captureSequence=read.captureSequence;
    row.identity=source.identity;row.bytes=source.bytes;row.sha256=source.sha256;
    row.protection=read.protection;row.flags=read.flags;
    row.lifetimeLeaseSequence=read.lifetimeLeaseSequence;row.executable=read.executable;
    row.inputModel=read.inputModel;
    if(Object.prototype.hasOwnProperty.call(source,'resolvedPath'))row.resolvedPath=source.resolvedPath;
    row.graphKey=[read.inputModel==='mapping'?'mapping':'read',read.captureSequence];
    if(read.form!==null&&read.form!==undefined&&read.form!==false){
      // NESTED unknowns are restored HERE. Dropping them was the cross-language
      // parity defect: Python kept them, TS silently returned only the known
      // fields, so a future Q proof field vanished on the TS side alone.
      row.regularRead={...(nestedExtra??{}),form:read.form,fd:read.fd,
        readLeaseSequence:read.readLeaseSequence,
        rangeStart:read.rangeStart,consumedLength:read.consumedLength,result:read.result,
        exitSequence:read.exitSequence,generation:source.generation,
        iovcnt:read.iovcnt,iovLengths:read.iovLengths};
    }
    inputs.push(row);
  }

  const witness:any[]=[];
  for(const output of outputs){
    if(!output||typeof output!=='object'||!Array.isArray(output.inputIds))return undefined;
    const resolved:any[]=[];
    for(const readId of output.inputIds){
      if(!Number.isSafeInteger(readId)||readId<0||readId>=inputs.length)return undefined;
      resolved.push(inputs[readId]);
    }
    const extra=output.extra;
    if(extra!==undefined&&(extra===null||typeof extra!=='object'||Array.isArray(extra)))return undefined;
    // PARITY WITH THE PYTHON DECODER: carried proof columns win over `extra`.
    // Python builds `row=dict(extra)` then `row.update(<carried>)`, so an extra
    // can never replace the proof. Spreading extra last let a transport override
    // bytes/sha256/inputComplete and desynchronise inputIds from `inputs`.
    witness.push({...(extra??{}),...output,inputs:resolved});
  }

  const custody=transportRows(value.custody,TRANSPORT_CUSTODY_FIELDS);
  const sourceClass=transportRows(value.sourceClass,TRANSPORT_SOURCECLASS_FIELDS);
  if(custody===undefined||sourceClass===undefined)return undefined;
  return Object.freeze({inputs,witness,graph:expandedGraph,custody,sourceClass});
};

export function inspectSdkToolchainOperationFileCoverage(input:{coverage:unknown;observedFiles:readonly any[];afterRows:readonly Readonly<{originalPath:string;bytes:number;sha256:string;mode:number}>[];binaryFiles:readonly DebianInstalledBinaryFile[];
  /** Optional typed provenance from the SAME verified input ownership view:
   * path -> the observer's own role/reason. Used only to CLASSIFY an origin, never
   * to waive an obligation. */
  originProvenance?:ReadonlyMap<string,'compile-output'|'generated-or-unobserved-before-compile'>;
  /** DERIVED compact causal graph exported by the SAME validated replay. It is
   * a deduplicated transport of the witness edges, never a second authority. */
  generatedGraph?:Readonly<Record<string,unknown>>;
  /** Canonical per-input table; witness rows carry only `inputIds`. */
  generatedInputs?:readonly Readonly<Record<string,unknown>>[];
  /** ONE closed versioned transport carrying the shared source rows, the
   * columnar per-read rows, the per-output references and the two per-lease
   * evidence tables. When present it SUPERSEDES
   * `generatedInputs`/`generatedWitness`/`generatedGraph` and is decoded here
   * before any proof runs; the projections stay supported for older callers. */
  generatedTransport?:Readonly<Record<string,unknown>>;
  /** Per-lease custody rows exported by the same private replay. */
  generatedReadCustody?:readonly Readonly<Record<string,unknown>>[];
  /** Per-lease SOURCE CLASS table exported by the same private replay. Byte
   * custody is not source authority; this classifies each credited lease. */
  generatedReadSourceClass?:readonly Readonly<Record<string,unknown>>[];
  /** Verified full-shard input rows from the SAME private SDK handle. */
  verifiedInputRows?:readonly Readonly<Record<string,unknown>>[];
  /** Verified input-ownership rows from the same private SDK view. */
  verifiedOwnershipRows?:readonly Readonly<Record<string,unknown>>[];
  /** Reviewed Git/patch postpatch members (RELATIVE paths) from the existing
   * same-private upstream observation, plus its already-verified source root. */
  verifiedGitPostpatchMembers?:readonly Readonly<{path:string;mode:number;bytes:number;sha256:string}>[];
  verifiedGitSourceRoot?:string;
  /** Prepared dependency byte rows closed by the FetchContent helper. */
  verifiedPreparedByteRows?:readonly Readonly<{path:string;bytes:number;sha256:string;mode:number}>[];
  /** DERIVED per-output causal witness exported by the validated replay:
   * exact output identity/bytes/sha, the completed producer-close sequence, the
   * producer execution image and the complete earlier read-only leased inputs of
   * the SAME producer process. A projection of proved facts, never a claim. */
  generatedWitness?:readonly Readonly<{path:string;bytes:number;sha256:string;identity:readonly string[];completedCloseSequence:number;producerCaptureSequence:number;inputComplete?:boolean;readOperations?:number;execImage:Readonly<{pid:number;phase:string;exe:string;identity:readonly string[];bytes:number;sha256:string;lifetimeLeaseSequence?:number}>|null;inputs:readonly Readonly<{entrySequence:number;captureSequence:number;identity:readonly string[];bytes:number;sha256:string;protection:number;flags:number;lifetimeLeaseSequence:number;executable:boolean}>[]}>[]},check:()=>void=()=>{}) {
  const coverage=input.coverage as any;
  need((coverage?.schemaVersion===1||coverage?.schemaVersion===2)&&Array.isArray(coverage.operations)&&coverage.operations.length>0&&coverage.operations.length<=limits.sourceMembers&&Array.isArray(coverage.pending),'complete nonempty operation projection required');
  need(Buffer.byteLength(JSON.stringify(coverage))<=limits.metadataBytes,'bounded operation projection required');
  const pending=new Set<string>(),files=new Map<string,Readonly<{path:string;bytes:number;sha256:string;mode:number;binary?:DebianInstalledBinaryFile['binary'];source?:DebianInstalledBinaryFile['source']}>>(),operations=new Set<string>();
  for(const reason of coverage.pending){need(typeof reason==='string'&&reason.length<=4096,'bounded exact missing coverage reason');pending.add(reason);}
// TYPED GENERATED-SOURCE JOIN. A generated artifact may be a SOURCE origin only
// when the same validated raw stream proves, for THAT output: its exact full
// identity/bytes/sha, a producer-close that actually COMPLETED, the producer's
// own execution image, and a nonempty set of earlier read-only LEASED inputs of
// the SAME producer process whose identities differ from the output and from each
// other, strictly before the completed close. Everything else stays unresolved.
type GeneratedWitness=Readonly<{path:string;bytes:number;sha256:string;identity:readonly string[];
  phase?:string;producerPid?:number;
  completedCloseSequence:number;producerCaptureSequence:number;inputComplete?:boolean;readOperations?:number;
  inputObligationCount?:number;readInputCount?:number;unexplainedReads?:readonly Readonly<Record<string,unknown>>[];
  execImage:Readonly<{pid:number;phase:string;exe:string;identity:readonly string[];bytes:number;sha256:string;lifetimeLeaseSequence?:number}>|null;
  inputs:readonly Readonly<{entrySequence:number;captureSequence:number;identity:readonly string[];bytes:number;sha256:string;protection:number;flags:number|null;lifetimeLeaseSequence:number|null;executable:boolean;
    inputModel?:string;regularRead?:Readonly<{form:string;fd:number;rangeStart:number;consumedLength:number;result:number;exitSequence:number;captureSequence?:number;generation:Readonly<{identity:readonly number[];flags:number;position:number}>;iovcnt:number|null;iovLengths:readonly number[]|null;readLeaseSequence?:number|null}>}>[]}>;
// The scanner wire stores every distinct input record ONCE and each output
// references it by integer id. Resolution is done here, before any proof, so the
// verifier keeps seeing a complete per-output input list; an id that is missing
// or out of range is REFUSED rather than silently narrowing the universe.
const resolveWitnessInputs=(witness:readonly any[]|undefined,table:readonly any[]|undefined):any[]|undefined=>{
  if(witness===undefined)return undefined;
  const byId=new Map<number,any>();
  for(const row of table??[]){
    if(!row||!Number.isSafeInteger(row.inputId)||row.inputId<0||byId.has(row.inputId))return undefined;
    byId.set(row.inputId,row);
  }
  const out:any[]=[];
  for(const w of witness as readonly any[]){
    if(!Array.isArray(w?.inputIds))return undefined;
    const inputs:any[]=[];
    for(const id of w.inputIds){
      const row=byId.get(id);
      if(row===undefined)return undefined;
      inputs.push(row);
    }
    out.push({...w,inputs});
  }
  return out;
};
/** DERIVE a read input's SOURCE origin from the SAME private verified proofs.
 *
 * A class NAME supplied by the producer is not authority; it is a hint at best.
 * This function only closes a class when the private SDK's own observations prove
 * the exact byte image belongs to a real origin:
 *
 *  * ``signed-debian-installed`` — an ownership row for this exact path/bytes/sha
 *    lists at least one SIGNED Debian binary owner, and the ledger tuple for that
 *    binary (name/version) is present. The exact source tuple then flows into the
 *    existing Debian source-archive join.
 *  * ``generated-same-phase`` — an earlier completed producer output of this same
 *    replay has the identical byte image (so a read of a generated header is
 *    traced back to the producer that wrote it).
 *  * ``prepared-fetchcontent`` — the path is inside a registered dependency root
 *    AND the ownership row carries the dependency source tuple. (Kept narrow: a
 *    path alone never closes it.)
 *
 * Anything else is unresolved. ``mode`` is permission bits only and is used for
 * the exact byte match, never as a file-type test.
 */
/** ONE per-inspection resolution context.
 *
 * Every origin branch reads from the SAME already-verified private
 * observations, indexed once so resolution is O(edges) rather than repeated
 * whole-array scans. Nothing here is caller-supplied or a producer label.
 */
type OriginRow={kind:string;detail:string;source?:any};
type GitMember=Readonly<{path:string;mode:number;bytes:number;sha256:string}>;
type PreparedRow=Readonly<{path:string;bytes:number;sha256:string;mode:number}>;
type OriginContext=Readonly<{
  verifiedSourceRows:readonly any[];
  ownershipByPath:ReadonlyMap<string,readonly any[]>;
  signedByPath:ReadonlyMap<string,readonly any[]>;
  /** canonical ABSOLUTE path -> verified Git postpatch member */
  gitByPath:ReadonlyMap<string,GitMember>;
  preparedByPath:ReadonlyMap<string,PreparedRow>;
  witnessByIdentity:ReadonlyMap<string,readonly any[]>;
  sourceRoot:string|null;
}>;
const identityKey=(identity:readonly unknown[])=>identity.map(String).join(',');
const buildOriginContext=(input:{verifiedSourceRows:readonly any[];ownershipRows:readonly any[];
  signedFiles:readonly any[];gitMembers:readonly GitMember[]|undefined;gitSourceRoot:string|null;
  preparedRows:readonly PreparedRow[]|undefined;witness:readonly any[]|undefined}):OriginContext=>{
  const ownershipByPath=new Map<string,any[]>(),signedByPath=new Map<string,any[]>();
  for(const row of input.ownershipRows){
    if(!row||typeof row.path!=='string')continue;
    const list=ownershipByPath.get(row.path);if(list)list.push(row);else ownershipByPath.set(row.path,[row]);
  }
  for(const file of input.signedFiles){
    if(!file||typeof file.installedPath!=='string')continue;
    const list=signedByPath.get(file.installedPath);if(list)list.push(file);else signedByPath.set(file.installedPath,[file]);
  }
  // Postpatch member paths are RELATIVE to the verified source root. The
  // canonical absolute join is applied ONCE here using the same verified root.
  const gitByPath=new Map<string,GitMember>();
  const root=input.gitSourceRoot;
  if(typeof root==='string'&&root.startsWith('/')&&root.length>1&&!root.endsWith('/')){
    for(const member of input.gitMembers??[]){
      if(!member||typeof member.path!=='string'||!member.path||member.path.startsWith('/'))continue;
      if(member.path.split('/').some((part:string)=>!part||part==='.'||part==='..'))continue;
      gitByPath.set(root+'/'+member.path,member);
    }
  }
  const preparedByPath=new Map<string,PreparedRow>();
  for(const row of input.preparedRows??[]){
    if(!row||typeof row.path!=='string'||!row.path.startsWith('/'))continue;
    if(preparedByPath.has(row.path))continue;
    preparedByPath.set(row.path,row);
  }
  const witnessByIdentity=new Map<string,any[]>();
  for(const w of input.witness??[]){
    if(!w||!Array.isArray(w.identity))continue;
    const key=identityKey(w.identity);
    const list=witnessByIdentity.get(key);if(list)list.push(w);else witnessByIdentity.set(key,[w]);
  }
  return Object.freeze({verifiedSourceRows:input.verifiedSourceRows,ownershipByPath,signedByPath,
    gitByPath,preparedByPath,witnessByIdentity,
    sourceRoot:typeof root==='string'?root:null});
};

/** Resolve the DIRECT (non-generated) origin of one exact byte image.
 * Requires exact path+bytes+sha+mode agreement for every branch. */
const directOrigin=(ctx:OriginContext,input:{path:string;bytes:number;sha256:string;mode:number}):OriginRow=>{
  // (1) signed Debian installed file: exact signed binary observation AND its
  // signed Packages/source tuple must both agree.
  for(const row of ctx.ownershipByPath.get(input.path)??[]){
    for(const owner of (row.owners??[])){
      if(!owner||typeof owner.source?.name!=='string'||typeof owner.source?.version!=='string')continue;
      const signed=(ctx.signedByPath.get(input.path)??[]).filter((file:any)=>file
        &&file.bytes===input.bytes&&file.sha256===input.sha256
        &&Number.isSafeInteger(file.mode)&&file.mode===input.mode
        &&file.binary?.name===owner.binary&&file.binary?.version===owner.binaryVersion
        &&file.source?.name===owner.source.name&&file.source?.version===owner.source.version);
      if(signed.length!==1)return {kind:'unresolved',
        detail:'ownership owner tuple has no matching signed Debian binary/byte observation'};
      return {kind:'signed-debian-installed',detail:'signed Debian binary observation matches this exact path/bytes/mode',
        source:{name:owner.source.name,version:owner.source.version,binary:owner.binary,binaryVersion:owner.binaryVersion}};
    }
  }
  // (2) reviewed Git/patch postpatch member, canonical join via verified root.
  const git=ctx.gitByPath.get(input.path);
  if(git&&git.bytes===input.bytes&&git.sha256===input.sha256&&git.mode===input.mode)
    return {kind:'upstream-reviewed-git',detail:'reviewed Git/patch postpatch member matches this exact canonical path/bytes/mode',
      source:{path:git.path,sourceRoot:ctx.sourceRoot}};
  // (3) prepared FetchContent dependency byte row (helper-closed byte set).
  const prepared=ctx.preparedByPath.get(input.path);
  if(prepared&&prepared.bytes===input.bytes&&prepared.sha256===input.sha256&&prepared.mode===input.mode)
    return {kind:'prepared-fetchcontent',detail:'prepared dependency byte row matches this exact path/bytes/mode',
      source:{path:prepared.path}};
  return {kind:'unresolved',detail:'no closed independent source origin for this exact byte image'};
};

/** Find the witness that PRODUCED one input edge of `consumer`.
 * Match on the input's own six-field identity plus its exact byte image, in the
 * same phase, with a completed close strictly before the consuming entry. */
const predecessorFor=(ctx:OriginContext,consumer:any,edge:any):any|undefined=>{
  if(!Array.isArray(edge?.identity))return undefined;
  const candidates=ctx.witnessByIdentity.get(identityKey(edge.identity));
  if(!candidates)return undefined;
  const matches=candidates.filter((w:any)=>w&&w!==consumer
    &&w.sha256===edge.sha256&&w.bytes===edge.bytes
    &&w.phase===consumer.phase
    &&positive(w.completedCloseSequence)
    &&w.completedCloseSequence<edge.entrySequence
    &&!isDeepStrictEqual(w.identity,consumer.identity));
  if(matches.length>1)return undefined;   // ambiguous: never guess
  return matches[0];
};

/** Resolve ONE exact byte image through the single origin context and record it.
 *
 * Shared by BOTH input models so a mapped input can never take a weaker path than
 * a regular read: a predecessor witness (full recursive verification) or a direct
 * signed/Git/prepared byte authority, with the same closed-origin projection.
 */
const resolveOriginEdge=(ctx:OriginContext,resolveEdge:((edge:any)=>OriginRow)|undefined,
  closedOrigins:Map<string,any>|undefined,
  target:Readonly<{path:string;bytes:number;sha256:string;mode:number}>,edge:any):OriginRow=>{
  const resolvedEdge=resolveEdge!==undefined
    ? resolveEdge({...edge,sourceMode:target.mode,resolvedPath:target.path})
    : directOrigin(ctx,target);
  if(closedOrigins!==undefined&&resolvedEdge.kind!=='unresolved'){
    const key=target.path+'\0'+target.bytes+'\0'+target.sha256;
    if(!closedOrigins.has(key))closedOrigins.set(key,Object.freeze({path:target.path,bytes:target.bytes,
      sha256:target.sha256,kind:resolvedEdge.kind,closed:true,source:resolvedEdge.source??null}));
  }
  return resolvedEdge;
};

const witnessByOutput=(list:readonly GeneratedWitness[]|undefined)=>new Map<string,GeneratedWitness>((list??[]).map(w=>[w.path,w]));
/** Memoized transitive evaluation over the ACTUAL input graph.
 *
 * A predecessor closes only if the SAME full `verifyWitness` accepts it: its own
 * exec image, complete input universe, every input's source AND custody, and its
 * own predecessors. The node count is the real witness count; recursion is an
 * explicit stack with three-state memoization (visiting/success/failure), so a
 * cycle is refused and no arbitrary depth cap exists.
 */
type WitnessVerdict={ok:boolean;reason?:string;readInputs?:number;mappingInputs?:number};
const evaluateWitnessGraph=(ctx:OriginContext,
  verifyWitness:(w:any,resolve:(edge:any)=>OriginRow,self:any)=>WitnessVerdict)=>(root:any):WitnessVerdict=>{
  const state=new Map<string,{status:'visiting'|'ok'|'bad';verdict:WitnessVerdict}>();
  const keyOf=(w:any)=>JSON.stringify([w.path,identityKey(w.identity),w.sha256,w.bytes,
    w.completedCloseSequence,w.phase]);
  const visiting=new Set<string>();
  const visit=(w:any):WitnessVerdict=>{
    // A caller may ask to verify an output with NO derived witness at all; that
    // is a normal refusal, not a crash.
    if(!w||typeof w!=='object')return {ok:false,reason:'no derived producer witness for this output'};
    const key=keyOf(w);
    const prior=state.get(key);
    if(prior)return prior.status==='visiting'
      ? {ok:false,reason:'generated source cycle detected'}
      : prior.verdict;
    if(visiting.has(key))return {ok:false,reason:'generated source cycle detected'};
    visiting.add(key);
    state.set(key,{status:'visiting',verdict:{ok:false,reason:'in progress'}});
    try{
      const verdict=verifyWitness(w,(edge:any):OriginRow=>{
        const predecessor=predecessorFor(ctx,w,edge);
        if(predecessor!==undefined){
          const resolved=visit(predecessor);
          if(resolved.ok)return {kind:'generated-same-phase',
            detail:'input producer itself has a fully verified source closure',
            source:{path:predecessor.path,completedCloseSequence:predecessor.completedCloseSequence,
              phase:predecessor.phase}};
          return {kind:'unresolved',detail:'input producer does not itself close: '+String(resolved.reason)};
        }
        // no generated producer for this edge: use the direct byte authorities
        const path=typeof edge?.resolvedPath==='string'?edge.resolvedPath:null;
        if(!absolute(path))return {kind:'unresolved',detail:'input edge has no canonical resolved target'};
        const mode=Number.isSafeInteger(edge?.sourceMode)?edge.sourceMode:undefined;
        if(mode===undefined)return {kind:'unresolved',detail:'input edge has no verified source mode'};
        return directOrigin(ctx,{path,bytes:edge.bytes,sha256:edge.sha256,mode});
      },w);
      state.set(key,{status:verdict.ok?'ok':'bad',verdict});
      return verdict;
    }finally{visiting.delete(key);}
  };
  return visit(root);
};

/** The REAL mapped byte observation behind one mapping input edge.
 *
 * The publisher derives a mapping input edge and the coverage's `mapOriginals`
 * entry from the SAME captured `toolchain-mapping-original` row, whose own
 * `sequence` becomes BOTH the edge's captureSequence and the mapOriginal's
 * captureSequence. That capture is unique within a phase. The observation binds
 * the canonical path, the six-field identity and the byte image together -- the
 * facts a mapping edge cannot carry on its own.
 */
type MappedObservation=Readonly<{path:string;identity:readonly string[];bytes:number;sha256:string;
  mode:number;phase:string}>;
/** Primary key: the capture the publisher copies into both the edge and the
 * mapOriginal. */
const mappedKey=(phase:unknown,captureSequence:unknown)=>String(phase)+'\0'+String(captureSequence);
/** Fallback key: the whole FILE byte image within one phase -- all six identity
 * fields (device, inode, mode, size, mtime, ctime) together with bytes+sha.
 *
 * This key is FILE-level, but a mapped observation is VMA-level: the publisher's
 * own mapping identity includes startHex/endHex/fileOffset, so ONE file
 * legitimately yields several mapOriginals that differ only in range, and two
 * producer PIDs may map one shared object in the same phase. Uniqueness is
 * therefore NOT an ingestion invariant here -- several observations may share it.
 * It is resolved per edge at LOOKUP time, where equivalent observations naming
 * the same canonical path+mode+byte image collapse to one source target and
 * genuinely different targets are refused rather than guessed. */
const mappedImageKey=(phase:unknown,identity:readonly unknown[],bytes:unknown,sha256:unknown)=>
  String(phase)+'\0'+identityKey(identity)+'\0'+String(bytes)+'\0'+String(sha256);

/** Resolve the image-key FALLBACK for ONE edge.
 *
 * Repeated real observations (one file at several VMAs, several producers mapping
 * one shared header) are normal and must not abort the inspection. Those that
 * name the SAME canonical target -- path + mode + byte image -- are ONE source
 * target, so any one of them is a valid representative. Two DISTINCT canonical
 * targets (or modes) for one edge's own tuple stay genuinely ambiguous: this
 * refuses them instead of picking a first candidate or inventing a weaker origin.
 */
const resolveMappedImageFallback=(byImage:ReadonlyMap<string,readonly MappedObservation[]>,
  phase:unknown,edge:any):{observation?:MappedObservation;reason?:string}=>{
  const candidates=(byImage.get(mappedImageKey(phase,edge.identity,edge.bytes,edge.sha256))??[])
    .filter(observation=>observation
      &&identityKey(observation.identity)===identityKey(edge.identity)
      &&observation.bytes===edge.bytes&&observation.sha256===edge.sha256);
  if(!candidates.length)return {};
  // Equivalent repeats of one source target collapse here; distinct targets do not.
  const targets=new Map<string,MappedObservation>();
  for(const candidate of candidates)targets.set(candidate.path+'\0'+String(candidate.mode),candidate);
  if(targets.size!==1)return {reason:'mapping input fallback matches '+String(targets.size)+' distinct canonical targets'};
  return {observation:[...targets.values()][0]};
};

const verifyGeneratedWitness=(w:any,ctx:OriginContext,readCustodyRows:readonly any[]=[],resolveEdge?:(edge:any)=>OriginRow,closedOrigins?:Map<string,any>,mapped?:ReadonlyMap<string,MappedObservation>,mappedByImage?:ReadonlyMap<string,readonly MappedObservation[]>):WitnessVerdict=>{
  if(!w||typeof w!=='object')return {ok:false,reason:'no derived producer witness for this output'};
  if(!absolute(w.path))return {ok:false,reason:'output path is not absolute'};
  if(!Array.isArray(w.identity)||w.identity.length!==6||!w.identity.every((v:unknown)=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(v)))return {ok:false,reason:'output identity is not six decimal strings'};
  if(!Number.isSafeInteger(w.bytes)||w.bytes<0||!sha(w.sha256))return {ok:false,reason:'output byte identity required'};
  if(!positive(w.completedCloseSequence)||!positive(w.producerCaptureSequence))return {ok:false,reason:'completed producer-close sequence required'};
  // a generated artifact must never be a signed Debian file
  if((ctx.signedByPath.get(w.path)??[]).length)return {ok:false,reason:'output also claims a Debian binary origin'};
  const exe=w.execImage;
  if(!exe||!positive(exe.pid)||!absolute(exe.exe)||!Array.isArray(exe.identity)||exe.identity.length!==6
     ||!Number.isSafeInteger(exe.bytes)||!sha(exe.sha256))return {ok:false,reason:'producer execution image origin required'};
  // the producer image must be a DIFFERENT object from the output it produced
  if(isDeepStrictEqual(exe.identity,w.identity))return {ok:false,reason:'producer image equals its own output'};
  // COMPLETENESS: a nonempty input set is NOT authority. If any read-family
  // operation by this producer remains unexplained, the input universe is a
  // subset and crediting it would over-credit (ROOT's one-of-two-inputs case).
  if(w.inputComplete!==true)return {ok:false,reason:'producer input universe is incomplete ('+String(w.readOperations??'?')+' unexplained read operations)'};
  const inputs=Array.isArray(w.inputs)?w.inputs:[];
  if(!inputs.length)return {ok:false,reason:'no actual required inputs observed for this producer'};
  const seen=new Set<string>(),seenB=new Set<string>();
  // The read ABI must be one of the reviewed kernel forms; a witness cannot
  // invent a name to bypass the range checks below.
  const READ_FORMS=new Set(['read','readv','pread64','preadv','preadv2']);
  let readInputs=0,mappingInputs=0;
  // STRUCTURAL PASS FIRST. Identity/byte/causality facts and the cross-input
  // duplicate rules are independent of any file resolution, so they are decided
  // before the per-model origin work. This keeps the refusal a precise structural
  // one instead of a downstream message about a record that was never admissible.
  {
    const structural=new Set<string>(),structuralIdentity=new Set<string>();
    for(const i of inputs){
      if(!positive(i.entrySequence)||!positive(i.captureSequence))return {ok:false,reason:'input edge lacks exact entry/capture sequence'};
      if(isDeepStrictEqual(i.identity,w.identity))return {ok:false,reason:'input edge is the output itself (cycle or self-read)'};
      if(!(i.entrySequence<w.completedCloseSequence))return {ok:false,reason:'input edge is not earlier than the completed close (future-close credit)'};
      if(!Number.isSafeInteger(i.bytes)||i.bytes<0||!sha(i.sha256))return {ok:false,reason:'input byte identity required'};
      const k=JSON.stringify(i.identity)+'\0'+i.bytes+'\0'+i.sha256;
      if(structural.has(k))continue;
      if(structuralIdentity.has(JSON.stringify(i.identity)))return {ok:false,reason:'same identity observed with two different byte versions'};
      structural.add(k);structuralIdentity.add(JSON.stringify(i.identity));
    }
  }
  for(const i of inputs){
    if(!positive(i.entrySequence)||!positive(i.captureSequence))return {ok:false,reason:'input edge lacks exact entry/capture sequence'};
    // SELF-EDGE / CYCLE: no input may be the output object itself
    if(isDeepStrictEqual(i.identity,w.identity))return {ok:false,reason:'input edge is the output itself (cycle or self-read)'};
    // CAUSALITY: every input must be strictly EARLIER than the completed close
    if(!(i.entrySequence<w.completedCloseSequence))return {ok:false,reason:'input edge is not earlier than the completed close (future-close credit)'};
    if(!Number.isSafeInteger(i.bytes)||i.bytes<0||!sha(i.sha256))return {ok:false,reason:'input byte identity required'};
    // TWO INDEPENDENT INPUT MODELS.
    //  * mapping   -> an immutable read-only VMA authorised by a held pre-use
    //                 lease. Lease AND read-only prot are BOTH mandatory.
    //  * read      -> a regular file consumed through a real read-family ABI.
    //                 There is no VMA and no lease, so the exact consumed range,
    //                 the real exit result and the FD generation are mandatory
    //                 instead. Both models must still be earlier than the close.
    const model=i.inputModel??'mapping';
    if(model==='mapping'){
      if(!positive(i.lifetimeLeaseSequence))return {ok:false,reason:'mapping input edge lacks its held pre-use lease'};
      if((i.protection&2)!==0)return {ok:false,reason:'input is writable, not an immutable read-only input'};
      // CUSTODY IS NOT SOURCE. The lease proves the mapped bytes could not change;
      // it says nothing about where the inode came from. A mapping edge carries no
      // resolvedPath of its own (the real publisher never emits one), so the
      // canonical target is derived ONLY from this inspection's already validated
      // mapped-byte observation captured at the SAME (phase, captureSequence): the
      // publisher derives both the edge and the coverage's mapOriginal from that
      // one captured row, and capture sequences are unique within a phase. The
      // identity and exact byte image are then re-checked against the edge.
      const exact=mapped?.get(mappedKey(w.phase,i.captureSequence));
      const exactMatches=exact!==undefined&&identityKey(exact.identity)===identityKey(i.identity)
        &&exact.bytes===i.bytes&&exact.sha256===i.sha256;
      let observation:MappedObservation|undefined;
      if(exactMatches)observation=exact;
      else if(mappedByImage!==undefined){
        // Fallback for producer revisions whose edge/mapOriginal captures differ.
        // Resolved PER EDGE: repeats of one file at several VMAs or across PIDs are
        // legitimate and collapse to the same source target; distinct targets refuse.
        const fallback=resolveMappedImageFallback(mappedByImage,w.phase,i);
        if(fallback.reason!==undefined)return {ok:false,reason:fallback.reason};
        observation=fallback.observation;
      }
      if(observation===undefined)return {ok:false,reason:'mapping input edge has no validated mapped byte observation for this exact capture'};
      if(identityKey(observation.identity)!==identityKey(i.identity))
        return {ok:false,reason:'mapping input observation names a different file identity'};
      if(observation.bytes!==i.bytes||observation.sha256!==i.sha256)
        return {ok:false,reason:'mapping input observation byte image differs from this edge'};
      // The same closed byte-origin contract a regular read must satisfy. Mode is
      // permission bits from the SAME validated observation, never a type guess.
      const sourceRows=ctx.verifiedSourceRows.filter((row:any)=>row&&row.originalPath===observation.path
        &&row.bytes===i.bytes&&row.sha256===i.sha256
        &&Number.isSafeInteger(row.mode)&&row.mode>=0&&row.mode<=0o7777);
      if(sourceRows.length!==1)return {ok:false,reason:'mapping input has no verified same-private source origin for its exact bytes'};
      if(sourceRows[0].mode!==observation.mode)
        return {ok:false,reason:'mapping input verified source mode differs from the mapped observation'};
      const resolvedEdge=resolveOriginEdge(ctx,resolveEdge,closedOrigins,
        {path:observation.path,bytes:i.bytes,sha256:i.sha256,mode:observation.mode},{...i});
      if(resolvedEdge.kind==='unresolved')
        return {ok:false,reason:'mapping input origin is unresolved: '+resolvedEdge.detail};
      mappingInputs++;
    } else if(model==='regular-read'){
      const read=i.regularRead;
      if(!read||!READ_FORMS.has(read.form))return {ok:false,reason:'regular read input has an unknown kernel ABI form'};
      if(!positive(read.exitSequence)||read.exitSequence<=i.entrySequence)return {ok:false,reason:'regular read input lacks its matching real exit'};
      if(!Number.isSafeInteger(read.fd)||read.fd<0)return {ok:false,reason:'regular read input lacks an exact descriptor'};
      if(!Number.isSafeInteger(read.rangeStart)||read.rangeStart<0)return {ok:false,reason:'regular read input range start invalid'};
      if(!Number.isSafeInteger(read.consumedLength)||read.consumedLength<0)return {ok:false,reason:'regular read input consumed length invalid'};
      if(!Number.isSafeInteger(read.result)||read.result!==read.consumedLength)return {ok:false,reason:'regular read result differs from its consumed length'};
      if(read.rangeStart+read.consumedLength>i.bytes)return {ok:false,reason:'regular read consumed past its captured bytes'};
      const generation=read.generation;
      // The six identity fields travel as DECIMAL STRINGS end to end (a
      // nanosecond timestamp is not a JS safe integer). The generator may emit
      // numbers, so both are normalised to their exact decimal text; nothing is
      // rounded through a float.
      if(!generation||!Array.isArray(generation.identity)||generation.identity.length!==6
         ||!generation.identity.every((v:unknown)=>(typeof v==='string'&&/^(?:0|[1-9][0-9]{0,19})$/u.test(v))||Number.isSafeInteger(v))
         ||!Number.isSafeInteger(generation.position))return {ok:false,reason:'regular read input lacks its exact FD generation proof'};
      // IMMUTABILITY, two independent facts. A read-only FD prevents only THAT
      // descriptor from writing; a different open file description or another
      // process could still mutate the inode. The real guarantee is the held
      // kernel read lease cited by this edge, which is also required to be
      // earlier than the read entry. The access mode is still checked, but it is
      // NOT the immutability claim on its own.
      if((generation.flags&3)!==0)return {ok:false,reason:'regular read input descriptor was not read-only'};
      const lease=read.readLeaseSequence??i.lifetimeLeaseSequence;
      if(!positive(lease))return {ok:false,reason:'regular read input lacks its held kernel read lease'};
      // A lease is acquired at the SYSCALL ENTRY STOP, so it may legitimately
      // fall between the raw entry row and the capture. It must simply precede
      // the observation; the exact own-entry binding is checked against the
      // exported custody row below.
      if(!(lease<i.captureSequence))return {ok:false,reason:'regular read lease was not held before the input capture (stale token)'};
      if(generation.identity.map((v:unknown)=>String(v)).join(',')!==i.identity.join(','))return {ok:false,reason:'regular read generation identity differs from the input identity'};
      if(read.form==='read'||read.form==='readv'){
        if(generation.position!==read.rangeStart)return {ok:false,reason:'position-based read start differs from the recorded generation position'};
      }
      // The cited lease must be one the SAME private replay exported for this
      // exact identity; a number that merely looks plausible is refused.
      // SOURCE AUTHORITY IS NOT BYTE CUSTODY. The lease proves the bytes could
      // not change; it does NOT prove where the file came from. Every credited
      // read input must therefore ALSO resolve to one verified input row (the
      // same private full-shard inventory the SDK source axis owns) with the
      // exact canonical resolved target, byte length, digest and mode. A path
      // prefix, a producer boolean or a bare read count can never substitute.
      const boundPath=typeof (i as any).resolvedPath==='string'?(i as any).resolvedPath:null;
      if(!absolute(boundPath))return {ok:false,reason:'regular read input lacks its canonical resolved target'};
      // MODE CONTRACT. The verified input inventory publishes `mode` as
      // `identity[2] & 0o7777`, i.e. PERMISSION bits only -- the file type lives
      // in the original identity, not in this field. Testing the type bits here
      // would be permanently false for every real row (0o644, 0o755, ...).
      const sourceRows=ctx.verifiedSourceRows.filter((row:any)=>row&&row.originalPath===boundPath
        &&row.bytes===i.bytes&&row.sha256===i.sha256
        &&Number.isSafeInteger(row.mode)&&row.mode>=0&&row.mode<=0o7777);
      if(sourceRows.length!==1)return {ok:false,reason:'regular read input has no verified same-private source origin for its exact bytes'};
      // SOURCE AUTHORITY resolves through the ONE context: an actual predecessor
      // witness (full recursive verification) or a direct signed/Git/prepared
      // byte authority. Never a producer class string.
      const resolvedEdge=resolveOriginEdge(ctx,resolveEdge,closedOrigins,
        {path:boundPath,bytes:i.bytes,sha256:i.sha256,mode:sourceRows[0].mode},{...i});
      if(resolvedEdge.kind==='unresolved')
        return {ok:false,reason:'regular read input origin is unresolved: '+resolvedEdge.detail};
      // MANDATORY custody association. An absent/empty exported table is NOT a
      // reason to skip this check: that would waive the proof the lease exists.
      if(!Array.isArray(readCustodyRows)||readCustodyRows.length===0)
        return {ok:false,reason:'regular read input has no exported per-lease custody table'};
      // Match the ASSOCIATION for this exact read: same lease, same identity,
      // same phase, same PID, same entry and same capture. A held lease is
      // legitimately shared by many producers reading the same header, so a
      // lease-only or identity-only match would either reject valid consumers or
      // bind the wrong read.
      const matches=readCustodyRows.filter((row:any)=>row&&row.leaseSequence===lease
        &&Array.isArray(row.identity)&&row.identity.length===6
        &&row.identity.map(String).join(',')===i.identity.join(',')
        &&row.phase===w.phase&&row.pid===w.producerPid
        &&row.entrySequence===i.entrySequence
        &&row.captureSequence===(i.regularRead?.captureSequence??i.captureSequence));
      if(matches.length!==1)return {ok:false,reason:'regular read lease is not the exported custody association for this exact read'};
      const custody=matches[0];
      if(!positive(custody.entrySequence)||custody.entrySequence!==i.entrySequence)
        return {ok:false,reason:'regular read custody row names a different read entry'};
      const acquisitionEntry=custody.acquisitionEntrySequence;
      if(!Number.isSafeInteger(acquisitionEntry)||acquisitionEntry<0)
        return {ok:false,reason:'regular read custody row lacks its acquisition entry binding'};
      if(acquisitionEntry!==i.entrySequence&&!(lease<i.entrySequence))
        return {ok:false,reason:'regular read lease was not held before use and is not bound to this entry'};
      if(!(lease<i.captureSequence))
        return {ok:false,reason:'regular read lease was acquired after the input capture'};
      if(!Number.isSafeInteger(i.captureSequence)||!(i.captureSequence<read.exitSequence))
        return {ok:false,reason:'regular read custody lacks capture-before-exit ordering'};
      readInputs++;
    } else return {ok:false,reason:'unknown input model'};
    const k=JSON.stringify(i.identity)+'\0'+i.bytes+'\0'+i.sha256;
    if(seen.has(k))continue;
    if(seenB.has(JSON.stringify(i.identity)))return {ok:false,reason:'same identity observed with two different byte versions'};
    seen.add(k);seenB.add(JSON.stringify(i.identity));
  }
  return {ok:true,readInputs,mappingInputs};
};
  // Per-input CLOSED generated-source origins, keyed path+bytes+sha. This is a
  // projection of facts this leaf already proved, published for the aggregate's
  // per-row non-Debian resolution. It grants no new authority by itself.
  const closedOrigins=new Map<string,any>();
  // Per-output facts this inspection itself PROVED: the producer's complete input
  // universe closed AND the witness describes this exact observed byte image.
  // Published only after the full exec/input/custody/origin graph accepted, so a
  // written/compile-output ROLE or a true boolean can never create one.
  const closedOutputs=new Map<string,any>();
  let operationCoverage=true,afterCoverage=true,binaryCoverage=true,stopProviderCoverage=true,execs=0,mappings=0,stopReadOnlyCaptures=0;
  // Typed per-class tallies: a generated artifact is not a Debian/RO obligation.
  let signedDebianFiles=0,generatedProducerFiles=0,unresolvedOriginFiles=0,generatedCredited=0,generatedCreditedWithReads=0,generatedCreditedWithMappings=0;
  const generatedPending=new Set<string>();
  // INDEXED TRANSPORT FIRST. When the caller passes the single closed transport,
  // it is decoded here and its tables take the place of the three projections;
  // every guard below then runs on the re-expanded records unchanged.
  //
  // A present transport must decode completely. Use its tables, including empty
  // ones; use legacy projections only when no transport was provided.
  const transportPresent=input.generatedTransport!==undefined&&input.generatedTransport!==null;
  const decodedTransport=decodeGeneratedProducerTransport(input.generatedTransport);
  need(!transportPresent||decodedTransport!==undefined,
    'present generated producer transport did not decode; refusing to fall back to legacy projections');
  const effectiveWitness=(decodedTransport?decodedTransport.witness:input.generatedWitness) as readonly any[]|undefined;
  const effectiveInputs=(decodedTransport?decodedTransport.inputs:input.generatedInputs) as readonly any[]|undefined;
  const effectiveGraph=(decodedTransport?decodedTransport.graph:input.generatedGraph) as any;
  const resolvedWitness=resolveWitnessInputs(effectiveWitness,effectiveInputs);
  // A witness whose ids did not resolve is unusable: every output would look
  // complete while its real inputs had been dropped.
  need(effectiveWitness===undefined||resolvedWitness!==undefined,
    'generated witness input ids did not resolve against the shared input table');
  // ONE resolution context over the SAME private verified views.
  const originContext=buildOriginContext({
    verifiedSourceRows:input.verifiedInputRows??[],
    ownershipRows:input.verifiedOwnershipRows??[],
    signedFiles:input.binaryFiles??[],
    gitMembers:input.verifiedGitPostpatchMembers,
    gitSourceRoot:input.verifiedGitSourceRoot??null,
    preparedRows:input.verifiedPreparedByteRows,
    witness:resolvedWitness??[]});
  const witness=witnessByOutput(resolvedWitness as readonly GeneratedWitness[]|undefined);
  // The SAME private replay exports, per credited regular-read lease, the exact
  // identity it protects. A witness may only cite those tokens.
  // When the emit side strips the top-level projections (the transport is then
  // the ONLY wire form), the per-lease tables arrive INSIDE the decoded
  // transport. Prefer those, and fall back to the explicit projections so both
  // calling conventions keep exactly the same evidence.
  // EXCLUSIVE when decoded: an empty decoded table means "no such rows", not
  // "look at the legacy array instead".
  const readCustodyRows=decodedTransport
    ?((decodedTransport.custody??[]) as readonly any[])
    :(Array.isArray(input.generatedReadCustody)?input.generatedReadCustody:[]);
  // The verified full-shard input inventory from the SAME private SDK handle.
  // Absent => no read input can claim SOURCE authority.
  const verifiedSourceRows=Array.isArray(input.verifiedInputRows)?input.verifiedInputRows:[];
  // VERIFIED OWNERSHIP ROWS: the same private input-ownership view that already
  // maps each input file to its signed Debian binary/source tuples. This is the
  // byte authority the origin derivation consults; a producer class string is not.
  const ownershipRows=Array.isArray(input.verifiedOwnershipRows)?input.verifiedOwnershipRows:[];
  const sourceClassRows=decodedTransport
    ?((decodedTransport.sourceClass??[]) as readonly any[])
    :(Array.isArray(input.generatedReadSourceClass)?input.generatedReadSourceClass:[]);
  const SOURCE_CLASSES=new Set(['prepared-fetchcontent','signed-debian-installed','generated-same-phase']);
  // COMPACT GRAPH REFS are validated structurally. They may only RESTATE the
  // per-output witness (same node/edge count and the same earliest causal
  // edges); a graph that disagrees with the witness is refused outright rather
  // than silently preferred. This keeps one authority (the witness) and one
  // transport (the graph) without duplicating byte images.
  // Use the DECODED graph when the transport supplied it; `input.generatedGraph`
  // is only the fallback for the projection path. Without this a transport-only
  // call discarded the re-expanded graph (`effectiveGraph` was never read).
  const graph=effectiveGraph as any;
  if(graph!==undefined)need(graph&&graph.schemaVersion===1&&graph.model==='compact-deduplicated-causal-graph-v1'
    &&Array.isArray(graph.nodes)&&Number.isSafeInteger(graph.nodeCount)&&Number.isSafeInteger(graph.edgeCount)
    &&graph.nodes.length===graph.nodeCount&&graph.edgeCount>=0,'bounded compact causal graph required');
  need(coverage.stopProviderPending===undefined||Array.isArray(coverage.stopProviderPending),'provider pending projection required');
  for(const reason of coverage.stopProviderPending??[]){need(typeof reason==='string'&&reason.length<=4096,'bounded provider pending');pending.add(reason);stopProviderCoverage=false;}
  // ORIGIN CLASSES. A generated build artifact (PCH, .o, linked binary) can never
// be a stopped-read-only-provider file nor a signed Debian installed binary nor a
// Debian source package, because the compiler must WRITE it into the build root.
// Demanding those three obligations of every mapped file makes the source axis
// permanently unsatisfiable. The class is derived from existing verified facts
// only -- never from a path prefix, a filename or a caller flag.
type OriginClass='signed-debian'|'generated-producer'|'unresolved';
const classifyOrigin=(file:any,binaryRows:readonly DebianInstalledBinaryFile[]):OriginClass=>{
  if(binaryRows.length===1)return 'signed-debian';
  // A file the observer itself classified as a compile output or an
  // unobserved-before-compile input is a GENERATED artifact of this same SDK.
  const provenance=input.originProvenance?.get(file.observedPath);
  if(provenance==='compile-output'||provenance==='generated-or-unobserved-before-compile')return 'generated-producer';
  return 'unresolved';
};
const join=(file:any,phase:string)=>{
    check();need(absolute(file?.observedPath)&&decimalIdentity(file.identityDecimal),'actual full decimal file identity required');
    const original=file.original;need(positive(file.originalCaptureSequence)&&original&&Number.isSafeInteger(original.bytes)&&original.bytes>=0&&original.bytes<=limits.shardBytes&&sha(original.sha256)&&typeof original.path==='string'&&!original.path.includes('/')&&!original.path.includes('\\'),'bounded actual file original required');
    const mode=Number(BigInt(file.identityDecimal[2])&0o7777n);need(BigInt(file.identityDecimal[3])===BigInt(original.bytes),'file identity size differs');
    const binary=input.binaryFiles.filter(row=>row.installedPath===file.observedPath&&row.bytes===original.bytes&&row.sha256===original.sha256&&row.mode===mode);
    need(binary.length<=1,'ambiguous signed Debian binary file');
    const originClass=classifyOrigin(file,binary);
    if(originClass==='unresolved')unresolvedOriginFiles++;else if(originClass==='signed-debian')signedDebianFiles++;else generatedProducerFiles++;
    // A generated artifact legitimately has NO read-only provider: the compiler
    // must write it into the build root. Requiring one is a category error, so the
    // RO obligation applies to the signed-Debian class only. The generated class
    // instead needs a producer-source witness, which this leaf cannot yet verify,
    // so it emits its own typed fail-closed pending.
    const provider=file.stopReadonlyProvider;
    if(originClass==='generated-producer'){
      // A generated artifact is credited ONLY through the derived causal witness:
      // completed producer close, producer execution image, and earlier read-only
      // leased inputs of the same producer process. Anything short of that stays
      // an unresolved obligation -- it is never waived for being under a build dir.
      const w=witness.get(file.observedPath);
      // ONE evaluator for the whole inspection; each distinct witness is
      // verified exactly once, with real predecessor recursion.
      const evaluate=evaluateWitnessGraph(originContext,(candidate,resolveEdge)=>verifyGeneratedWitness(candidate,originContext,readCustodyRows,resolveEdge,closedOrigins,mappedObservations,mappedImageObservations));
      let verdict=evaluate(w);
      // the witness must describe THIS file's exact observed byte identity
      if(verdict.ok&&(!isDeepStrictEqual(w!.identity,file.identityDecimal)||w!.bytes!==original.bytes||w!.sha256!==original.sha256))
        verdict={ok:false,reason:'witness identity/bytes do not match this observed file'};
      if(verdict.ok){
        generatedCredited++;
        if((verdict.readInputs??0)>0)generatedCreditedWithReads++;
        if((verdict.mappingInputs??0)>0)generatedCreditedWithMappings++;
        // The producer's OUTPUT byte image, bound to the SAME observed identity/
        // bytes/mode/phase this join just accepted. It is a distinct fact from the
        // INPUT origins above: an output is not an input to its own producer.
        const outputKey=file.observedPath+'\0'+original.bytes+'\0'+original.sha256;
        if(!closedOutputs.has(outputKey))closedOutputs.set(outputKey,Object.freeze({
          path:file.observedPath,bytes:original.bytes,sha256:original.sha256,mode,
          identity:Object.freeze([...file.identityDecimal]),phase,
          completedCloseSequence:w?.completedCloseSequence??null,closed:true}));
      }
      else generatedPending.add('qlever-sdk-generated-build-output-producer-source-causality-unverified:'+file.observedPath+':'+String(verdict.reason));
    } else if(provider===undefined||provider===null){stopProviderCoverage=false;pending.add('qlever-sdk-toolchain-stop-readonly-provider-original-unavailable:'+file.observedPath);}
    else {
      need(provider.scope==='actual stopped tracee namespace named-FD effective read-only provider only'&&isDeepStrictEqual(provider.identityDecimal,file.identityDecimal)&&positive(provider.provider?.mountId)
        &&typeof provider.mountNamespace==='string'&&/^mnt:\[[0-9]+\]$/u.test(provider.mountNamespace)&&decimalIdentity(provider.mountNamespaceIdentityDecimal)&&BigInt(provider.mountNamespace.slice(5,-1))===BigInt(provider.mountNamespaceIdentityDecimal[1])
        &&decimalIdentity(provider.rootIdentityDecimal)&&(BigInt(provider.rootIdentityDecimal[2])&0o170000n)===0o040000n&&provider.mountinfoOriginal&&positive(provider.mountinfoOriginal.bytes)&&provider.mountinfoOriginal.bytes<=limits.metadataBytes&&sha(provider.mountinfoOriginal.sha256)
        &&typeof provider.mountinfoOriginal.path==='string'&&/^capture-[0-9]{4,}\.original$/u.test(provider.mountinfoOriginal.path),'verified stopped provider/file relation differs');
      stopReadOnlyCaptures++;
    }
    const observed=input.observedFiles.filter(row=>row.phase===phase&&row.captureSequence===file.originalCaptureSequence);
    need(observed.length<=1,'ambiguous actual stopped file original');
    if(observed.length!==1||observed[0].path!==file.observedPath||observed[0].bytes!==original.bytes||observed[0].sha256!==original.sha256||observed[0].mode!==mode||!isDeepStrictEqual(observed[0].identityDecimal,file.identityDecimal)){
      afterCoverage=false;pending.add('toolchain-operation-observed-file-binding-unavailable:'+file.observedPath);
    }
    const after=input.afterRows.filter(row=>row.originalPath===file.observedPath);need(after.length<=1,'ambiguous verified after path');
    if(after.length!==1||after[0]!.bytes!==original.bytes||after[0]!.sha256!==original.sha256||after[0]!.mode!==mode){afterCoverage=false;pending.add('toolchain-operation-after-shard-binding-unavailable:'+file.observedPath);}
    if(originClass==='generated-producer'){
      // no signed-Debian obligation is applicable to a generated artifact
    } else if(binary.length!==1){binaryCoverage=false;pending.add('toolchain-operation-signed-Debian-binary-unavailable:'+file.observedPath);}
    // Only a signed-Debian origin belongs in the Debian source-archive join. A
    // generated artifact must never be pushed through that join, and it is still
    // recorded here so the caller sees its typed pending.
    if(originClass==='signed-debian'){
      const row=Object.freeze({path:file.observedPath,bytes:original.bytes,sha256:original.sha256,mode,...(binary[0]?{binary:binary[0].binary,source:binary[0].source}:{})});
      const previous=files.get(file.observedPath);need(!previous||isDeepStrictEqual(previous,row),'tool file changed between observed operations');files.set(file.observedPath,row);
    }
  };
  // TWO PHASES, ONE UNIVERSE. Phase A validates every operation and every file
  // record and records the REAL mapped byte observation for each mapOriginal.
  // Phase B then runs the generated-source join. The split exists because a
  // mapping input edge carries no path of its own: its canonical target can only
  // come from the validated mapped observation, which must therefore be complete
  // BEFORE any witness is evaluated. No file is joined twice and no obligation is
  // deferred: an operation that fails Phase A aborts the whole inspection.
  // Repeated observations of ONE file (multiple VMAs, or several producer PIDs
  // sharing an object) are ordinary, so the file-level image key collects them
  // rather than rejecting them; only the exact per-capture key stays unique.
  const mappedObservations=new Map<string,MappedObservation>();
  // Image-key CANDIDATES: legitimately many per file (several VMAs / producers).
  const mappedImageObservations=new Map<string,MappedObservation[]>();
  const joins:(readonly [any,string])[]=[];
  const fileRecord=(file:any,phase:string)=>{
    check();need(absolute(file?.observedPath)&&decimalIdentity(file.identityDecimal),'actual full decimal file identity required');
    const original=file.original;need(positive(file.originalCaptureSequence)&&original&&Number.isSafeInteger(original.bytes)&&original.bytes>=0&&original.bytes<=limits.shardBytes&&sha(original.sha256)&&typeof original.path==='string'&&!original.path.includes('/')&&!original.path.includes('\\'),'bounded actual file original required');
    const mode=Number(BigInt(file.identityDecimal[2])&0o7777n);need(BigInt(file.identityDecimal[3])===BigInt(original.bytes),'file identity size differs');
    return {phase,mode,path:file.observedPath as string,bytes:original.bytes as number,sha256:original.sha256 as string,
      identity:file.identityDecimal as readonly string[],actual:file};
  };
  for(const op of sdkToolchainOperations(coverage,check)){
    check();need(['exec','mmap','protect'].includes(op?.kind)&&['configure','compile'].includes(op.phase)&&positive(op.pid)&&positive(op.entrySequence)&&positive(op.captureSequence)&&op.entrySequence<op.captureSequence&&Number.isSafeInteger(op.expectedFileMappingCount)&&op.expectedFileMappingCount>=0&&Array.isArray(op.mapOriginals)&&Array.isArray(op.unresolved),'actual operation relation required');
    const key=op.phase+':'+op.captureSequence;need(!operations.has(key),'duplicate operation capture');operations.add(key);
    if(op.kind==='exec'){
      need(positive(op.execEventSequence)&&op.entrySequence<op.execEventSequence&&op.execEventSequence<op.captureSequence&&op.primaryFile,'actual exec stop/image relation required');
      execs++;const record=fileRecord(op.primaryFile,op.phase);joins.push([record.actual,op.phase]);
    }
    else need(positive(op.exitSequence)&&op.entrySequence<op.exitSequence&&op.exitSequence<op.captureSequence,'actual successful mapping/protection result relation required');
    if(op.mapOriginals.length!==op.expectedFileMappingCount||op.unresolved.length){operationCoverage=false;pending.add('toolchain-operation-file-mapping-coverage-incomplete:'+key);}
    for(const reason of op.unresolved){need(typeof reason==='string'&&reason.length<=4096,'bounded exact missing coverage reason');pending.add(reason);}
    const ranges=new Set<string>();
    for(const file of op.mapOriginals){
      need(positive(file.captureSequence)&&file.captureSequence>op.captureSequence&&file.mapping&&typeof file.mapping.startHex==='string'&&typeof file.mapping.endHex==='string','actual VMA capture relation required');
      const range=JSON.stringify(file.mapping);need(!ranges.has(range),'duplicate VMA obligation');ranges.add(range);mappings++;
      const record=fileRecord(file,op.phase);
      // The SAME validated row binds the canonical path, the six-field identity
      // and the byte image. One capture sequence names one object, so a second,
      // DIFFERENT observation under that exact key is ambiguous and refused.
      const observation=Object.freeze({path:record.path,identity:record.identity,
        bytes:record.bytes,sha256:record.sha256,mode:record.mode,phase:op.phase,pid:op.pid,
        originalCaptureSequence:file.originalCaptureSequence});
      const exactKey=mappedKey(op.phase,file.captureSequence);
      const previous=mappedObservations.get(exactKey);
      need(previous===undefined||isDeepStrictEqual(previous,observation),'ambiguous mapped byte observation');
      mappedObservations.set(exactKey,observation);
      // The whole-file image key is NOT a uniqueness invariant: several legitimate
      // VMAs/PIDs of one file share it. Collect every observation; resolution is
      // lazy and per edge, so ordinary repeats never abort ingestion.
      const imageKey=mappedImageKey(op.phase,record.identity,record.bytes,record.sha256);
      const collected=mappedImageObservations.get(imageKey);
      if(collected===undefined)mappedImageObservations.set(imageKey,[observation]);
      else if(!collected.some(row=>isDeepStrictEqual(row,observation)))collected.push(observation);
      joins.push([record.actual,op.phase]);
    }
  }
  // Phase B: the ONE generated-source join, now able to resolve mapped inputs.
  for(const [file,phase] of joins)join(file,phase);
  // GRAPH/WITNESS AGREEMENT. If a graph is present it must RESTATE the witness:
  // every witness output must exist as an output node with the SAME completed
  // close, and every graph edge must be an earlier, different input node. A
  // mismatch is refused rather than resolved in either direction.
  if(graph!==undefined){
    need(Array.isArray(graph.nodes)&&Array.isArray(graph.inputSets)
      &&Number.isSafeInteger(graph.edgeSetCount)&&graph.edgeSetCount===graph.inputSets.length,
      'compact causal graph node/edge-set arrays required');
    const nodeIds=new Set<number>();
    for(const node of graph.nodes){
      need(node&&Number.isSafeInteger(node.nodeId)&&node.nodeId>=0&&!nodeIds.has(node.nodeId)&&typeof node.model==='string'
        &&decimalIdentity(node.identity)&&Number.isSafeInteger(node.bytes)&&sha(node.sha256),
        'bounded causal graph node required');
      nodeIds.add(node.nodeId);
    }
    const sets=new Map<number,any>();
    for(const set of graph.inputSets){
      need(set&&Number.isSafeInteger(set.setId)&&set.setId>=0&&!sets.has(set.setId)&&Array.isArray(set.edges)
        &&set.edges.length<=limits.sourceMembers,'bounded causal input set required');
      for(const edge of set.edges){
        need(Array.isArray(edge)&&edge.length===11&&Number.isSafeInteger(edge[0])&&nodeIds.has(edge[0])
          &&Number.isSafeInteger(edge[1])&&positive(edge[2]),'bounded causal edge shape required');
      }
      sets.set(set.setId,set);
    }
    let graphEdges=0;
    // Use the EFFECTIVE witness: on a transport-only call `input.generatedWitness`
    // is undefined, so reading it here would leave graphEdges at 0 and reject a
    // perfectly consistent transport graph.
    for(const w of (resolvedWitness??input.generatedWitness??[])){
      const node=graph.nodes.find((item:any)=>item.model==='output'
        &&decimalIdentity(item.identity)&&item.identity.length===6&&item.identity.join(',')===w.identity.join(',')
        &&item.bytes===w.bytes&&item.sha256===w.sha256);
      if(!node)continue;
      need(node.completedCloseSequence===w.completedCloseSequence,'causal graph close differs from the witness');
      const set=sets.get(node.inputSetId);
      need(set&&set.edges.length===(w.inputs??[]).length,'causal input set differs from the witness edge count');
      const seenInputs=new Set<number>();
      for(const edge of set.edges){
        // Per-output causality is resolved HERE, from the output node's own
        // completed close, so a shared edge set can still never carry a future
        // edge for any consumer of it.
        need(edge[0]!==node.nodeId,'causal graph self/intra edge');
        need(positive(edge[1])&&edge[1]<node.completedCloseSequence,'causal graph future edge');
        need(!seenInputs.has(edge[0]),'causal graph duplicate edge');seenInputs.add(edge[0]);graphEdges++;
      }
    }
    need(graphEdges===Number(graph.edgeCount??-1),'causal graph edge count differs from its resolved edges');
  }
  need(execs>0&&files.size<=limits.sourceMembers,'non-vacuous executable universe required');
  if(coverage.pending.length)operationCoverage=false;
  // Provider immutability and complete source-archive joins are separate proofs.
  // This leaf deliberately cannot turn after-only bytes into execution-time RO.
  if(!stopProviderCoverage)pending.add('qlever-sdk-toolchain-effective-readonly-provider-coverage-unavailable');
  for(const reason of generatedPending)pending.add(reason);
  pending.add('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');
  pending.add('qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable');
  return Object.freeze({facts:Object.freeze({sdkToolchainOperationCoverageVerified:operationCoverage,sdkToolchainObservedAfterFileBindingsVerified:operationCoverage&&afterCoverage,sdkToolchainSignedDebianBinaryFileBindingsVerified:operationCoverage&&afterCoverage&&binaryCoverage,sdkToolchainStopReadOnlyProviderCoverageVerified:operationCoverage&&afterCoverage&&stopProviderCoverage,sdkToolchainReadOnlyProviderScope:'at independently verified all-stop captures only',sdkToolchainStopReadOnlyCaptureCount:stopReadOnlyCaptures,sdkToolchainOperationCount:operations.size,sdkToolchainExecutionCount:execs,sdkToolchainMappedVmaCount:mappings,sdkToolchainSignedFileCoordinates:Object.freeze([...files.values()]),sdkToolchainSignedDebianFileCount:signedDebianFiles,sdkToolchainGeneratedProducerFileCount:generatedProducerFiles,sdkToolchainUnresolvedOriginFileCount:unresolvedOriginFiles,sdkToolchainGeneratedProducerPending:Object.freeze([...generatedPending]),sdkToolchainGeneratedProducerCreditedCount:generatedCredited,sdkToolchainGeneratedProducerSourceVerified:generatedProducerFiles>0&&generatedCredited===generatedProducerFiles,
    sdkToolchainGeneratedProducerReadInputCreditedCount:generatedCreditedWithReads,
    sdkToolchainGeneratedProducerMappingInputCreditedCount:generatedCreditedWithMappings,
    sdkToolchainGeneratedProducerInputOrigins:Object.freeze([...closedOrigins.values()]),
    // CLOSED OUTPUT BYTE IMAGES. Kept DISTINCT from input origins: a producer's
    // own output is not an input to itself. Only outputs whose complete existing
    // graph validation succeeded appear here.
    sdkToolchainGeneratedProducerClosedOutputs:Object.freeze([...closedOutputs.values()]),
    sdkToolchainGeneratedProducerGraph:graph===undefined?null:Object.freeze({schemaVersion:graph.schemaVersion,model:graph.model,nodeCount:graph.nodeCount,edgeSetCount:graph.edgeSetCount,edgeCount:graph.edgeCount}),sdkToolchainSourceClosureVerified:false}),pending:Object.freeze([...pending])});
}

/** No map/issuer: this leaf consumes only the existing same-SDK private maps. */
const ARCHIVE_GAP='qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable';
type OriginalRef=Readonly<{path:string;bytes:number;sha256:string}>;
const sourceRef=(value:any):value is OriginalRef=>value&&typeof value.path==='string'&&value.path.startsWith('inner/')&&!/[\\\x00-\x1f\x7f]/u.test(value.path)&&value.path.split('/').every((part:string)=>part&&part!=='.'&&part!=='..')&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=limits.shardBytes&&sha(value.sha256);
const sameRef=(left:any,right:any)=>sourceRef(left)&&sourceRef(right)&&left.path===right.path&&left.bytes===right.bytes&&left.sha256===right.sha256;
/** Diagnostic byte/coordinate relation only. Only the wrapper below supplies
 * existing same-SDK private signature, checksum, binary and source views. */
export function inspectSdkToolchainSourceArchiveJoin(input:{files:readonly any[];coordinates:readonly any[];collection:any;checksums:readonly any[];signedReleases:readonly any[]},check:()=>void=()=>{}) {
 check();need(input.files.length>0&&input.files.length<=limits.sourceMembers&&input.coordinates.length>0&&input.coordinates.length<=4096,'bounded nonempty tool/source universe required');
 const collection=input.collection;need(collection?.schemaVersion===1&&collection.kind==='qlever-sdk-exact-debian-source-originals'&&Array.isArray(collection.packages)&&collection.packages.length===input.coordinates.length&&Array.isArray(collection.indexOriginals)&&collection.indexOriginals.length>0&&collection.indexOriginals.length<=32,'same actual source collection required');
 need(input.checksums.length===collection.indexOriginals.length,'complete private checksum index set required');
 // The signature adapter observes each actual InRelease path once, even when
 // several component Sources indexes share those exact signed bytes.
 const releases=new Map<string,OriginalRef>();
 for(const index of collection.indexOriginals){check();need(sourceRef(index.inRelease),'actual signed release reference required');const previous=releases.get(index.inRelease.path);need(!previous||sameRef(previous,index.inRelease),'same InRelease path has conflicting original bytes');releases.set(index.inRelease.path,index.inRelease);}
 need(input.signedReleases.length===releases.size,'complete distinct private signature release set required');
 for(const release of releases.values()){check();const matches=input.signedReleases.filter(row=>sameRef(row.inRelease,release));need(matches.length===1&&Array.isArray(matches[0].signers)&&matches[0].signers.length>0,'same InRelease independently signed authority required');}
 const indexes=new Set<string>();
 for(const index of collection.indexOriginals){check();need(sourceRef(index.inRelease)&&sourceRef(index.sources)&&!indexes.has(index.sources.path),'unique actual source index required');indexes.add(index.sources.path);
  const matches=input.checksums.filter(row=>row.inReleaseSha256===index.inRelease.sha256&&sameRef(row.sourceOriginal,index.sources));need(matches.length===1&&Array.isArray(matches[0].observation?.signedIndexMatches)&&matches[0].observation.signedIndexMatches.length>0,'actual Sources checksum/private index binding required');
 }
 const coordinates=new Map<string,any>();
 for(const row of input.coordinates){check();need(typeof row.name==='string'&&row.name.length<=256&&typeof row.version==='string'&&row.version.length<=4096&&sourceRef(row.dsc)&&Array.isArray(row.archives)&&row.archives.length>0&&row.archives.length<=4096,'complete source coordinate and archive refs required');const key=row.name+'\0'+row.version;need(!coordinates.has(key),'duplicate private source coordinate');
  const packages=collection.packages.filter((item:any)=>item.name===row.name&&item.version===row.version);need(packages.length===1&&sameRef(packages[0].dsc,row.dsc)&&Array.isArray(packages[0].files)&&packages[0].files.length===row.archives.length,'actual source collection coordinate differs');
  const paths=new Set<string>();for(const ref of row.archives){check();need(sourceRef(ref)&&!paths.has(ref.path)&&packages[0].files.filter((item:any)=>sameRef(item,ref)).length===1,'all actual archive refs must match the private verified collection');paths.add(ref.path);}coordinates.set(key,row);
 }
 const selected=new Map<string,any>();
 for(const file of input.files){check();need(file?.source&&typeof file.source.name==='string'&&typeof file.source.version==='string','every actual signed tool requires a source tuple');const key=file.source.name+'\0'+file.source.version,row=coordinates.get(key);need(row,'exact tool source tuple has no verified complete source archives');selected.set(key,row);}
 return Object.freeze({sdkToolchainExactSourceArchiveCoverageVerified:true,sdkToolchainSourceArchiveCoordinates:Object.freeze([...selected.values()]),sdkToolchainSourceArchiveScope:'same-SDK signed Sources to complete DSC/archive byte sets for actual signed tool files only'});
}
export async function observeQleverSdkToolchainSourceOriginals(capability:unknown,sourceCapability:unknown,remainingMilliseconds=limits.timeoutMs):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>>{
  const facts:Record<string,unknown>={sdkToolchainOperationCoverageVerified:false,sdkToolchainObservedAfterFileBindingsVerified:false,sdkToolchainSignedDebianBinaryFileBindingsVerified:false,sdkToolchainStopReadOnlyProviderCoverageVerified:false,sdkToolchainExactSourceArchiveCoverageVerified:false,sdkToolchainSourceClosureVerified:false};
  try{
    need(Number.isFinite(remainingMilliseconds)&&remainingMilliseconds>=1,'remaining observation budget required');const end=performance.now()+Math.min(remainingMilliseconds,limits.timeoutMs);const check=()=>need(performance.now()<end,'shared toolchain observation deadline exhausted');check();
    const sdk=qleverSdkOriginalsView(capability),source=derivedSourceView(sourceCapability),inputs=sdkVerifiedInputOriginalView(capability),execution=qleverSdkExecutionOriginalObservation(capability),binary=qleverSdkDebianBinaryObservation(capability);
    need(sdk&&source&&inputs&&execution?.sdkActualConfigureCompileTrackedWaitVerified===true&&source.sourceSha===sdk.originFacts.sourceSha,'same private SDK/source/input/execution views required');
    need(execution.sdkToolchainOperationCoverage,'verified per-operation file coverage unavailable');
    const archives=sdkVerifiedSourceArchiveOriginalView(capability),checksumRows=qleverSdkDebianIndexObservation(capability),signature=qleverSdkDebianSignatureObservation(capability);
    const tools=await observeQleverSdkObservedToolOriginals(capability,sourceCapability,end-performance.now());check();need(tools.assertCurrent,'same private observed-tool custody unavailable');
    // SAME-PRIVATE-VIEW BINDINGS, read BEFORE the first guard invocation. These
    // are lexical `const`s, so evaluating the guard's closure body earlier than
    // their initialization is a temporal-dead-zone throw that would make every
    // operational call fail even with valid private views.
    const generatedWitness=(execution as any).sdkVerifiedGeneratedProducerWitness as readonly any[]|undefined;
    const generatedInputs=(execution as any).sdkVerifiedGeneratedProducerInputs as readonly any[]|undefined;
    const generatedTransport=(execution as any).sdkVerifiedGeneratedProducerTransport as Readonly<Record<string,unknown>>|undefined;
    const generatedGraph=(execution as any).sdkVerifiedGeneratedProducerGraph as Readonly<Record<string,unknown>>|undefined;
    const regularReadCustody=(execution as any).sdkVerifiedRegularReadCustody as readonly any[]|undefined;
    const regularReadSourceClass=(execution as any).sdkVerifiedRegularReadSourceClass as readonly any[]|undefined;
    // CURRENTNESS anchors on the RAW private getter references (including the
    // transport itself), never on values derived from them: the decoded arrays
    // are freshly created objects, so comparing them would either be vacuous or
    // always false.
    const assertCurrent=()=>{need(qleverSdkOriginalsView(capability)===sdk&&derivedSourceView(sourceCapability)===source&&qleverSdkExecutionOriginalObservation(capability)===execution&&qleverSdkDebianBinaryObservation(capability)===binary,'private toolchain observation custody changed');const currentGenerated=(qleverSdkExecutionOriginalObservation(capability) as any);need(currentGenerated?.sdkVerifiedGeneratedProducerWitness===generatedWitness&&currentGenerated?.sdkVerifiedGeneratedProducerGraph===generatedGraph&&currentGenerated?.sdkVerifiedGeneratedProducerInputs===generatedInputs&&currentGenerated?.sdkVerifiedGeneratedProducerTransport===generatedTransport&&currentGenerated?.sdkVerifiedRegularReadCustody===regularReadCustody,'private generated witness/input-table/graph/transport/read-custody custody changed');const current=sdkVerifiedInputOriginalView(capability);need(current?.rows===inputs.rows&&current.afterReference===inputs.afterReference,'private full-shard input custody changed');assertDerivedSourceCurrent(sourceCapability);binary?.assertCurrent();tools.assertCurrent!();need(sdkVerifiedSourceArchiveOriginalView(capability)===archives&&qleverSdkDebianIndexObservation(capability)===checksumRows&&qleverSdkDebianSignatureObservation(capability)===signature,'private source archive/signature/checksum observation custody changed');archives?.assertCurrent();};
    assertCurrent();
    // Typed provenance comes ONLY from the already-verified input ownership rows.
    // A role here classifies an origin; it never waives an obligation.
    // Ownership (including each input's signed-Debian binary/source tuples) comes
    // from the SAME verified full-shard input view that publishes rows. There is
    // deliberately NO fallback to any other object: a missing bridge must fail
    // closed rather than silently classify from a weaker source.
    // The SAME private Git/prepared observations, consumed through their
    // narrow getters (never a raw facts object or a guessed result shape).
    const gitObservation=qleverSdkUpstreamGitObservation(capability);
    const preparedByteRows=qleverSdkFetchContentByteRows(capability);
    const inputView=sdkVerifiedInputOriginalView(capability);
    need(inputView!==undefined,'verified full-shard input view unavailable');
    const ownership=inputView.ownership;
    need(ownership!==undefined,'verified input ownership view unavailable on the same private map');
    const provenance=new Map<string,'compile-output'|'generated-or-unobserved-before-compile'>();
    for(const row of ownership?.unresolvedInputs??[]){
      if(row.role!=='installed-metadata'&&(row.reason==='generated-or-unobserved-before-compile'||row.role==='compile-output'))provenance.set(row.path,row.role==='compile-output'?'compile-output':'generated-or-unobserved-before-compile');
    }
    // The DERIVED producer witness and compact causal graph come only from the
    // same private execution observation that carries the verified operations.
    // No public JSON, no caller flag and no second observation can supply them.
    // DECODE THE CLOSED TRANSPORT FIRST. When the emit side strips the five
    // projections the transport is the ONLY wire form, so requiring the raw
    // arrays would reject exactly the intended production shape. The decoded
    // tables are the SAME records, re-expanded here and handed to the same deep
    // verifier; a present-but-malformed transport still fails closed inside
    // decodeGeneratedProducerTransport.
    // Apply the same complete-transport selection rule as the pure inspector.
    const transportPresent=generatedTransport!==undefined&&generatedTransport!==null;
    const decodedTransport=decodeGeneratedProducerTransport(generatedTransport);
    need(!transportPresent||decodedTransport!==undefined,
      'present generated producer transport did not decode; refusing to fall back to legacy projections');
    const effectiveWitness=decodedTransport?decodedTransport.witness:generatedWitness;
    const effectiveInputs=decodedTransport?decodedTransport.inputs:generatedInputs;
    const effectiveGraph=decodedTransport?decodedTransport.graph:generatedGraph;
    const effectiveCustody=decodedTransport
      ?((decodedTransport.custody??[]) as readonly any[])
      :regularReadCustody;
    // STRONG AVAILABILITY: a closed proof needs BOTH the witness and the shared
    // input table it resolves against. Accepting one without the other lets a
    // witness keep its output-looking completeness with its real inputs dropped.
    // The transport supplies both, so transport-only still satisfies this.
    need(Array.isArray(effectiveWitness)&&Array.isArray(effectiveInputs),
      'derived generated producer witness AND input table (or a closed transport carrying both) required on the same private execution view');
    // The custody table is REQUIRED, not optional: its absence must fail closed
    // here rather than silently skipping every per-read association.
    need(Array.isArray(effectiveCustody),'derived regular-read custody table unavailable on the same private execution view');
    // The source-class table is transport-only bookkeeping, NOT an origin proof:
    // it is passed through when present but never required as private authority.
    const result=inspectSdkToolchainOperationFileCoverage({coverage:execution.sdkToolchainOperationCoverage,observedFiles:(tools.facts.sdkObservedToolAfterShardFiles as readonly any[]|undefined)??[],afterRows:inputs.rows,binaryFiles:binary?.files??[],originProvenance:provenance,generatedWitness:effectiveWitness,generatedInputs:effectiveInputs,generatedGraph:effectiveGraph,generatedReadCustody:effectiveCustody,generatedReadSourceClass:regularReadSourceClass,
      // COMPLETE Q9 SOURCE CONTEXT. These four arguments were dropped when the
      // caller was rewritten, which left every real input unresolved.
      verifiedInputRows:(inputs.rows as readonly any[]),
      verifiedOwnershipRows:ownership.inputRows,
      verifiedGitPostpatchMembers:gitObservation?.postpatchMembers,
      verifiedGitSourceRoot:gitObservation?.sourceRoot,
      verifiedPreparedByteRows:preparedByteRows},check);assertCurrent();const joinedFacts:Record<string,unknown>={...result.facts,sdkToolchainExactSourceArchiveCoverageVerified:false};const pending=new Set([...result.pending,...tools.pending]);
    if(archives&&checksumRows&&signature?.sdkDebianOfficialSignatureAndSuiteVerified===true&&binary&&result.facts.sdkToolchainSignedDebianBinaryFileBindingsVerified===true){
      try{
        need(archives.sourceSha===source.sourceSha&&archives.target===sdk.originFacts.target&&archives.officialAuthorityVerified===false,'same SDK mechanical source projection required');
        const readJson=(ref:OriginalRef,maximum=limits.metadataBytes)=>{check();need(ref&&typeof ref.path==='string'&&!ref.path.startsWith('/')&&!/[\\\x00-\x1f\x7f]/u.test(ref.path)&&ref.path.split('/').every(part=>part&&part!=='.'&&part!=='..')&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0&&ref.bytes<=maximum&&sha(ref.sha256),'bounded same SDK source metadata required');const bytes=sdk.readOriginal(ref.path,maximum);check();need(bytes.length===ref.bytes&&createHash('sha256').update(bytes).digest('hex')===ref.sha256,'actual source metadata bytes differ');return JSON.parse(bytes.toString());};
        const master=readJson(sdk.masterReference,8*1024**2);need(sameRef(master.debianSources,archives.collection),'private source collection differs from same SDK master');const collection=readJson(archives.collection);
        const signed=(signature.sdkDebianSignatureOriginals as {observations?:readonly unknown[]}|undefined)?.observations;need(Array.isArray(signed),'independent signature originals unavailable');
        const signedFiles=result.facts.sdkToolchainSignedFileCoordinates as readonly any[];
        if(signedFiles.length===0){
          // No signed-Debian tool origin exists in this SDK, so the Debian archive
          // join has no subject. That is INAPPLICABLE, not a failure -- demanding
          // Debian sources for a pure-generated artifact set is a category error.
          joinedFacts.sdkToolchainExactSourceArchiveCoverageVerified=true;
          joinedFacts.sdkToolchainSourceArchiveScope='not applicable: no signed-Debian tool origin in this SDK';
          pending.delete(ARCHIVE_GAP);
        } else {
        const joined=inspectSdkToolchainSourceArchiveJoin({files:result.facts.sdkToolchainSignedFileCoordinates,coordinates:archives.coordinates,collection,checksums:checksumRows,signedReleases:signed},check);check();assertCurrent();Object.assign(joinedFacts,joined);pending.delete(ARCHIVE_GAP);
        }
      }catch(error){pending.add('qlever-sdk-toolchain-source-archive-join-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
    }
    // Only the same SDK's private, fully replayed execution observation can
    // discharge lifetime immutability. A public JSON diagnostic cannot do so.
    if(execution.sdkToolchainExecutionLifetimeImmutabilityVerified===true){
      joinedFacts.sdkToolchainExecutionLifetimeImmutabilityVerified=true;
      joinedFacts.sdkToolchainExecutionLifetimeScope=execution.sdkToolchainExecutionLifetimeScope;
      pending.delete('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');
    }
    // The generated-input axis is required ONLY when this SDK actually has
    // generated producer outputs. A generated file counts only when EVERY one of
    // them has its own verified witness; a pure signed-Debian SDK is unaffected.
    const generatedPresent=Number(joinedFacts.sdkToolchainGeneratedProducerFileCount??0)>0;
    const generatedSatisfied=!generatedPresent||joinedFacts.sdkToolchainGeneratedProducerSourceVerified===true;
    joinedFacts.sdkToolchainGeneratedAxisRequired=generatedPresent;
    joinedFacts.sdkToolchainSourceClosureVerified=joinedFacts.sdkToolchainExecutionLifetimeImmutabilityVerified===true
      && joinedFacts.sdkToolchainOperationCoverageVerified===true
      && joinedFacts.sdkToolchainObservedAfterFileBindingsVerified===true
      && joinedFacts.sdkToolchainSignedDebianBinaryFileBindingsVerified===true
      && joinedFacts.sdkToolchainStopReadOnlyProviderCoverageVerified===true
      && joinedFacts.sdkToolchainExactSourceArchiveCoverageVerified===true
      && (generatedPresent?generatedSatisfied:true) && pending.size===0;
    check();assertCurrent();return Object.freeze({facts:Object.freeze(joinedFacts),pending:Object.freeze([...pending]),assertCurrent});
  }catch(error){return Object.freeze({facts:Object.freeze(facts),pending:Object.freeze(['qlever-sdk-toolchain-private-coverage-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024)])});}
}
