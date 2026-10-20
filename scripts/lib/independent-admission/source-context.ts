import {isCandidateServiceImageGitHubOrigin} from './github-origin';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactCapability, DerivedSourceCapability, DerivedSourceView } from './artifact-contract';

const sourceLimits = JSON.parse(readFileSync(new URL('../module-artifact-limits.json', import.meta.url), 'utf8'));
const issued = new WeakMap<object, DerivedSourceView>();
const currentChecks=new WeakMap<object,()=>void>();
export function assertDerivedSourceCurrent(value:unknown):void{
 if(!value||typeof value!=='object'||!issued.has(value)||!currentChecks.has(value))throw Error('Issued immutable source required');currentChecks.get(value)!();
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
function deriveExactAdmissionSource(sourceSha:string,checkout:string,assertAuthority:()=>void):Readonly<{root:string;source:DerivedSourceCapability}> {
  assertAuthority();const root = realpathSync(checkout);
  const git = (args: string[], maxBuffer = 4 * 1024 ** 2) => execFileSync('git', args,
    { cwd: root, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return Object.freeze({ mode: entry.mode, bytes });
  };
  const view: DerivedSourceView = Object.freeze({ sourceSha, trackedPaths: Object.freeze([...entries.keys()].sort()), readTrackedGitObject: readGitObject,
    readTracked(name: string): Buffer {
      const entry = entries.get(name);
      if (!entry || !['100644', '100755'].includes(entry.mode)) return fail('ordinary tracked source blob required');
      return readGitObject(name).bytes;
    } });
  const capability = Object.freeze({}) as DerivedSourceCapability;
  issued.set(capability, view); currentChecks.set(capability,()=>{
    assertAuthority();if(realpathSync(checkout)!==root||git(['rev-parse','HEAD']).toString().trim()!==sourceSha||git(['status','--porcelain','--untracked-files=all']).length!==0)fail('clean exact source checkout changed');
  });assertAuthority();return Object.freeze({root,source:capability});
}
