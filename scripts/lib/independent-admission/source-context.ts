import {registryLegalLockEntries} from './legal-registry-originals';
import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactCapability, DerivedSourceCapability, DerivedSourceView } from './artifact-contract';

const sourceLimits = JSON.parse(readFileSync(new URL('../module-artifact-limits.json', import.meta.url), 'utf8'));
const issued = new WeakMap<object, DerivedSourceView>();
const bulkSources=new WeakMap<object,{root:string;entries:ReadonlyMap<string,{mode:string;oid:string}>}>();
type SourceDeadline={check():void;remainingMs():number};
type SourceQualificationBudget=SourceDeadline & {chargeReadBytes(bytes:number):void;reserveBytes(bytes:number):void};
const sourceBudgets=new WeakMap<object,SourceQualificationBudget>();
function sourceBudget(value:unknown,budget?:SourceDeadline):SourceDeadline|undefined {
 const bound=value&&typeof value==='object'?sourceBudgets.get(value):undefined;
 if(bound&&budget&&bound!==budget)throw Error('Derived source parent budget differs');
 return bound??budget;
}
/** Bind only the genuine source handle, before qualification reads. */
export function bindDerivedSourceBudget(value:unknown,budget:SourceQualificationBudget):void {
 if(!value||typeof value!=='object'||!issued.has(value))throw Error('Issued immutable source required');
 sourceBudget(value,budget);budget.check();sourceBudgets.set(value,budget);
 assertDerivedSourceCurrent(value,budget);
}
const currentChecks=new WeakMap<object,(budget?:SourceDeadline)=>void>();
export function assertDerivedSourceCurrent(value:unknown,budget?:SourceDeadline):void{
 if(!value||typeof value!=='object'||!issued.has(value)||!currentChecks.has(value))throw Error('Issued immutable source required');currentChecks.get(value)!(sourceBudget(value,budget));
}
const artifactCheckouts = new WeakMap<object, Readonly<{root:string;source:DerivedSourceCapability}>>();
const fail = (message: string): never => { throw new Error('Independent derived source: ' + message); };

export function derivedSourceView(value: unknown): DerivedSourceView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}

/** Available only after this process derived immutable source for the exact
 * real artifact. Used by the fixed consumer to deny reads of the checkout. */
export function collectedArtifactSourceCheckout(artifact: unknown): string | undefined {
  return artifact && typeof artifact === 'object' && collectedArtifactView(artifact) ? artifactCheckouts.get(artifact)?.root : undefined;
}

/** Returns only this process's source handle bound to the exact real artifact. */
export function collectedArtifactDerivedSource(artifact: unknown): DerivedSourceCapability | undefined {
  if (!artifact || typeof artifact !== 'object' || !collectedArtifactView(artifact)) return undefined;
  const source = artifactCheckouts.get(artifact)?.source;
  if (source) assertDerivedSourceCurrent(source);
  return source;
}

/** Derives immutable tracked blobs from a clean exact checkout bound to a real
 * collected artifact. Neither arbitrary read callbacks nor JSON issue handles. */
export function deriveAdmissionSource(artifact: CollectedArtifactCapability, checkout: string): DerivedSourceCapability {
  const collected = collectedArtifactView(artifact);
  if (!collected) return fail('collected artifact capability required');
  const result=deriveExactAdmissionSource(collected.identity.sourceSha,checkout,()=>{if(collectedArtifactView(artifact)!==collected)fail('original collected artifact custody changed');});
  artifactCheckouts.set(artifact,Object.freeze(result));return result.source;
}
/** Same source issuer and exact Git implementation, restricted to the genuine
 * candidate-image role; this grants immutable source custody, never service ABI. */
export function deriveCandidateServiceSource(originals:unknown,checkout:string):DerivedSourceCapability {
 const view=nativeOriginalsView(originals);if(!view||!isCandidateServiceImageGitHubOrigin(view.origin))return fail('issued candidate service image originals required');
 const guard=()=>{if(nativeOriginalsView(originals)!==view||!isCandidateServiceImageGitHubOrigin(view.origin))fail('candidate service original handle changed');assertCollectedNativeOriginalCustody(originals);};
 guard();return deriveExactAdmissionSource(view.originFacts.sourceSha,checkout,guard).source;
}
type ServiceGitDependencyBinding=Readonly<{source:unknown;originals:unknown;name:string;repository:string;commit:string;integrity:string;view:DerivedSourceView;assertCurrent():void}>;
const serviceGitDependencies=new WeakMap<object,ServiceGitDependencyBinding>();
/** Same source issuer. The immutable parent chooses the dependency identity;
 * this only proves pinned Git source, never installation or build output. */
export function deriveCandidateServiceGitDependencySource(input:{originals:unknown;source:unknown;name:string;checkout:string;budget:{check():void;remainingMs():number}}):DerivedSourceCapability {
 const native=nativeOriginalsView(input.originals),parent=derivedSourceView(input.source);
 if(!native||!parent||!isCandidateServiceImageGitHubOrigin(native.origin)||native.originFacts.sourceSha!==parent.sourceSha)return fail('same private candidate parent required');
 const guardParent=()=>{input.budget.check();assertDerivedSourceCurrent(input.source);assertCollectedNativeOriginalCustody(input.originals);native.readOriginalRange('service-image-materials.json',0,0);if(nativeOriginalsView(input.originals)!==native||derivedSourceView(input.source)!==parent)fail('Git dependency parent custody differs');};
 guardParent();const manifest=JSON.parse(parent.readTracked('package.json').toString('utf8'));
 const declarations=['dependencies','devDependencies','optionalDependencies'].map(key=>manifest[key]?.[input.name]).filter(value=>value!==undefined);
 if(!declarations.length||!declarations.every(value=>value===declarations[0])||typeof declarations[0]!=='string')fail('one immutable dependency declaration required');
 const match=/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([a-f0-9]{40})$/u.exec(declarations[0]);
 if(!match||match[1]!.split('/').some(part=>part==='.'||part==='..'))return fail('complete immutable GitHub repository/commit required');
 const repository=match[1]!,commit=match[2]!,prefix=input.name+'@github:'+repository+'#';
 const lock=[...registryLegalLockEntries(parent.readTracked('bun.lock'))].filter(([key])=>key.startsWith(prefix));
 if(lock.length!==1||!/^[a-f0-9]{7,40}$/u.test(lock[0]![0].slice(prefix.length))||!commit.startsWith(lock[0]![0].slice(prefix.length)))fail('immutable Git dependency lock identity differs');
 const root=realpathSync(input.checkout);
 const git=(args:string[])=>{input.budget.check();const remaining=input.budget.remainingMs();if(!Number.isFinite(remaining)||remaining<=0)fail('shared Git source deadline exhausted');const bytes=execFileSync('git',['--no-replace-objects',...args],{cwd:root,timeout:Math.max(1,Math.floor(remaining)),maxBuffer:4*1024**2,stdio:['ignore','pipe','pipe']});input.budget.check();return bytes;};
 const url='https://github.com/'+repository+'.git';
 if(git(['remote','get-url','origin']).toString().trim()!==url||git(['for-each-ref','--format=%(refname)','refs/replace']).length)fail('canonical official Git remote and no replacement objects required');
 // Validate the actual object graph, not a producer success flag or remote text.
 git(['fsck','--strict','--no-reflogs','--no-dangling',commit]);
 const guard=()=>{guardParent();if(realpathSync(input.checkout)!==root||git(['remote','get-url','origin']).toString().trim()!==url||git(['for-each-ref','--format=%(refname)','refs/replace']).length)fail('Git dependency origin/custody changed');};
 const result=deriveExactAdmissionSource(commit,root,guard,input.budget);git(['fsck','--strict','--no-reflogs','--no-dangling',commit]);
 const originalView=derivedSourceView(result.source)!;
 const assertCurrent=()=>{assertDerivedSourceCurrent(result.source);};
 const view:DerivedSourceView=Object.freeze({...originalView,readTracked(name:string){assertCurrent();const bytes=originalView.readTracked(name);assertCurrent();return Buffer.from(bytes);},readTrackedGitObject(name:string,exact?:number){assertCurrent();const row=originalView.readTrackedGitObject!(name,exact);assertCurrent();return Object.freeze({mode:row.mode,bytes:Buffer.from(row.bytes)});}});
 serviceGitDependencies.set(result.source,Object.freeze({source:input.source,originals:input.originals,name:input.name,repository,commit,integrity:lock[0]![1],view,assertCurrent}));
 assertCurrent();return result.source;
}
export function candidateServiceGitDependencySourceView(value:unknown,input:{originals:unknown;source:unknown;name:string}) {
 const binding=value&&typeof value==='object'?serviceGitDependencies.get(value):undefined;
 if(!binding||binding.originals!==input.originals||binding.source!==input.source||binding.name!==input.name)return undefined;
 binding.assertCurrent();return binding;
}
function deriveExactAdmissionSource(sourceSha:string,checkout:string,assertAuthority:()=>void,budget?:{check():void;remainingMs():number}):Readonly<{root:string;source:DerivedSourceCapability}> {
  const capability = Object.freeze({}) as DerivedSourceCapability;
  assertAuthority();const root = realpathSync(checkout);
  const git = (args: string[], maxBuffer = 4 * 1024 ** 2, operationBudget=budget) => {
    operationBudget=sourceBudget(capability,operationBudget);
    operationBudget?.check();const remaining=operationBudget?.remainingMs();
    if(remaining!==undefined&&(!Number.isFinite(remaining)||remaining<=0))return fail('shared derived Git deadline exhausted');
    const bytes=execFileSync('git', ['--no-replace-objects',...args],
      { cwd: root, maxBuffer, killSignal:'SIGKILL', env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0'}, stdio: ['ignore', 'pipe', 'pipe'],...(remaining===undefined?{}:{timeout:Math.max(1,Math.floor(remaining))}) });
    operationBudget?.check();sourceBudgets.get(capability)?.chargeReadBytes(bytes.length);return bytes;
  };
  if (git(['rev-parse', 'HEAD']).toString().trim() !== sourceSha
    || git(['status', '--porcelain', '--untracked-files=all']).length !== 0) fail('clean exact source checkout required');
  const tree = git(['ls-tree', '-rz', '--full-tree', sourceSha], 16 * 1024 ** 2).toString('utf8');
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const row of tree.split('\0').filter(Boolean)) {
    const match = /^([0-9]{6}) blob ([a-f0-9]{40})\t(.+)$/u.exec(row);
    // Submodule/tree rows are not ordinary tracked build inputs.
    if (!match) continue;
    if (entries.has(match[3])) fail('duplicate tracked path');
    entries.set(match[3], { mode: match[1], oid: match[2] });
  }
  const readGitObject = (name: string, exactBytes?: number) => {
    const entry = entries.get(name);
    if (!entry || !['100644', '100755', '120000'].includes(entry.mode)) return fail('tracked ordinary/symlink Git blob required');
    // Only the complete-source verifier supplies this already charged row size.
    // Ordinary callers retain the historical 4 MiB bound.
    if (exactBytes !== undefined && (!Number.isSafeInteger(exactBytes) || exactBytes < 0 || exactBytes > sourceLimits.shardBytes)) return fail('tracked Git exact byte bound');
    const sizeText = git(['cat-file', '-s', entry.oid], 128).toString('ascii').trim();
    if (!/^(0|[1-9][0-9]*)$/u.test(sizeText)) return fail('tracked Git object size');
    const size = Number(sizeText), maximum = exactBytes ?? 4 * 1024 ** 2;
    if (!Number.isSafeInteger(size) || size > maximum || (exactBytes !== undefined && size !== exactBytes)) return fail('tracked Git object exceeds exact byte bound');
    const bytes = git(['cat-file', 'blob', entry.oid], Math.max(1, size));
    if (bytes.length !== size) return fail('tracked Git object size changed');
    const oid = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    if (oid !== entry.oid) return fail('tracked Git blob identity mismatch');
    sourceBudgets.get(capability)?.reserveBytes(bytes.length);
    return Object.freeze({ mode: entry.mode, bytes });
  };
  const view: DerivedSourceView = Object.freeze({ sourceSha, trackedPaths: Object.freeze([...entries.keys()].sort()), readTrackedGitObject: readGitObject,
    readTracked(name: string): Buffer {
      const entry = entries.get(name);
      if (!entry || !['100644', '100755'].includes(entry.mode)) return fail('ordinary tracked source blob required');
      return readGitObject(name).bytes;
    } });
  issued.set(capability, view); bulkSources.set(capability,{root,entries}); currentChecks.set(capability,(operationBudget)=>{
    assertAuthority();if(realpathSync(checkout)!==root||git(['rev-parse','HEAD'],4*1024**2,operationBudget).toString().trim()!==sourceSha||git(['status','--porcelain','--untracked-files=all'],4*1024**2,operationBudget).length!==0)fail('clean exact source checkout changed');
  });assertAuthority();return Object.freeze({root,source:capability});
}

/** One bounded Git child for the complete immutable input set. Bytes are still
 * checked against each already authenticated tree OID; no checkout file is read.
 * This is a reader of the existing source capability, not a new source issuer. */
export async function visitDerivedSourceOriginals(value: unknown, input: {
  budget: {check(): void; remainingMs(): number; chargeReadBytes(bytes: number): void; reserveBytes(bytes: number): void};
  paths?: readonly string[];
  visit(row: Readonly<{path: string; mode: string; sha256: string}>, bytes: Buffer): void;
}): Promise<void> {
  const held=value&&typeof value==='object'?bulkSources.get(value):undefined;
  if(!held||!derivedSourceView(value)) return fail('genuine bulk source capability required');
  input.budget.check();assertDerivedSourceCurrent(value,input.budget);
  const selected=input.paths===undefined?[...held.entries.keys()]:[...input.paths];
  if(!selected.length||selected.length>sourceLimits.members||new Set(selected).size!==selected.length||selected.some(name=>typeof name!=='string'||!held.entries.has(name)))return fail('unique authenticated Git paths required');
  const rows=selected.sort().map(name=>[name,held.entries.get(name)!] as const);
  if(rows.length>sourceLimits.members)fail('source member bound');
  const remaining=input.budget.remainingMs();
  if(!Number.isFinite(remaining)||remaining<=0)fail('shared Git batch deadline exhausted');
  // Same owned-process-group rule as owned-mode-command: reader teardown is
  // never counted as an observed child close. This service replay requires POSIX.
  if(process.platform==='win32')return fail('owned Git process groups required');
  const child=spawn('git',['--no-replace-objects','cat-file','--batch'],{cwd:held.root,detached:true,
    env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0'},stdio:['pipe','pipe','pipe']});
  let spawnError:Error|undefined;
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
    child.on('error',error=>{spawnError=error;});child.on('close',(code,signal)=>resolve({code,signal}));
  });
  let timedOut=false,stderrBytes=0,stderrOverflow=false,ownershipUnknown=false;
  let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  let resolveUnclosed:()=>void=()=>{};
  const unclosed=new Promise<undefined>(resolve=>{resolveUnclosed=()=>resolve(undefined);});
  const signalGroup=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')ownershipUnknown=true;}};
  const groupAbsent=()=>{if(!child.pid)return !!spawnError;try{process.kill(-child.pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;ownershipUnknown=true;return false;}};
  const abort=()=>{signalGroup();cleanupTimer??=setTimeout(()=>{
    ownershipUnknown=true;child.stdout.destroy(new Error('Git child close was not observed'));child.stderr.destroy();child.stdin.destroy();child.unref();resolveUnclosed();
  },1000);};
  const waitClosed=()=>Promise.race([closed,unclosed]);
  const timer=setTimeout(()=>{timedOut=true;abort();},Math.max(1,Math.floor(remaining)));
  child.stderr.on('data',(bytes:Buffer)=>{stderrBytes+=bytes.length;if(stderrBytes>65536){stderrOverflow=true;abort();}});
  child.stdin.on('error',error=>{spawnError??=error;});
  child.stdin.end(rows.map(([,entry])=>entry.oid+'\n').join(''));
  let index=0,at=0,total=0,terminator=false;let header:Buffer=Buffer.alloc(0),body:Buffer|undefined;
  const guard=()=>{input.budget.check();if(timedOut||input.budget.remainingMs()<=0)fail('shared Git batch deadline exhausted');};
  try {
    for await(const incoming of child.stdout){
      const chunk=Buffer.from(incoming as Buffer);guard();input.budget.chargeReadBytes(chunk.length);
      let cursor=0;
      while(cursor<chunk.length){
        guard();
        if(terminator){
          if(chunk[cursor++]!==10)fail('Git batch body terminator');
          const [name,entry]=rows[index]!;
          const oid=createHash('sha1').update(Buffer.from('blob '+body!.length+'\0')).update(body!).digest('hex');
          if(oid!==entry.oid)fail('immutable bulk Git blob identity mismatch');
          const record=Object.freeze({path:name,mode:entry.mode,sha256:createHash('sha256').update(body!).digest('hex')});
          const visited:any=input.visit(record,body!);if(visited&&typeof visited.then==='function'){Promise.resolve(visited).catch(()=>{});fail('synchronous Git original visitor required');}guard();
          index++;body=undefined;header=Buffer.alloc(0);terminator=false;at=0;continue;
        }
        if(body){
          const count=Math.min(body.length-at,chunk.length-cursor);chunk.copy(body,at,cursor,cursor+count);at+=count;cursor+=count;
          if(at===body.length)terminator=true;
          continue;
        }
        const newline=chunk.indexOf(10,cursor),end=newline<0?chunk.length:newline;
        if(header.length+end-cursor>128)fail('bounded Git batch header');
        header=Buffer.concat([header,chunk.subarray(cursor,end)]);cursor=end;
        if(newline<0)continue;
        cursor++;const match=/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/u.exec(header.toString('ascii'));
        const row=rows[index];
        if(!match||!row||row[1].oid!==match[1]||!['100644','100755','120000'].includes(row[1].mode))return fail('exact Git batch tree entry');
        const size=Number(match[2]);total+=size;
        if(!Number.isSafeInteger(size)||size>sourceLimits.shardBytes||total>sourceLimits.sourceMaterialBytes)fail('same source byte bounds');
        input.budget.reserveBytes(size);guard();body=Buffer.alloc(size);at=0;terminator=size===0;
      }
    }
    const outcome=await waitClosed();guard();
    if(!outcome||ownershipUnknown||!groupAbsent()||spawnError||stderrOverflow||outcome.code!==0||outcome.signal!==null||index!==rows.length||body||header.length)fail('complete natural Git batch required');
    assertDerivedSourceCurrent(value,input.budget);guard();
  } catch(error) {abort();await waitClosed();throw error;}
  finally {clearTimeout(timer);clearTimeout(cleanupTimer);}
}


/** Bounded, authenticated bytes for synchronous parsers. This is a read view of
 * the existing source capability, not another provenance issuer. */
export async function readDerivedSourceOriginals(source: unknown, paths: readonly string[], budget: {
  check(): void; remainingMs(): number; chargeReadBytes(bytes: number): void; reserveBytes(bytes: number): void;
}): Promise<Readonly<{readTracked(path: string): Buffer; readTrackedGitObject(path: string): Readonly<{mode: string; bytes: Buffer}>; assertCurrent(): void}>> {
  const view = derivedSourceView(source);
  if (!view) return fail('genuine source capability required for original reads');
  const originals = new Map<string, Readonly<{mode: string; bytes: Buffer}>>();
  await visitDerivedSourceOriginals(source, { paths, budget, visit(row, bytes) {
    if (row.mode !== '100644' && row.mode !== '100755') return fail('regular tracked source original required');
    originals.set(row.path, Object.freeze({mode: row.mode, bytes}));
  } });
  const assertCurrent = () => {
    budget.check();
    if (derivedSourceView(source) !== view) return fail('same source capability required');
    assertDerivedSourceCurrent(source, budget);
    budget.check();
  };
  assertCurrent();
  const readTrackedGitObject = (name: string): Readonly<{mode: string; bytes: Buffer}> => {
    assertCurrent(); const original = originals.get(name);
    if (!original) return fail('tracked original was not requested');
    // The batch read and each returned copy are separate logical reads.
    budget.chargeReadBytes(original.bytes.length); budget.reserveBytes(original.bytes.length);
    const bytes = Buffer.from(original.bytes); assertCurrent();
    return Object.freeze({mode: original.mode, bytes});
  };
  return Object.freeze({ assertCurrent, readTrackedGitObject,
    readTracked(name: string): Buffer { return readTrackedGitObject(name).bytes; }
  });
}
