import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactCapability, DerivedSourceCapability, DerivedSourceView } from './artifact-contract';

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
  const root = realpathSync(checkout);
  const git = (args: string[], maxBuffer = 4 * 1024 ** 2) => execFileSync('git', args,
    { cwd: root, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
  const sourceSha = collected.identity.sourceSha;
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
  const readGitObject = (name: string) => {
    const entry = entries.get(name);
    if (!entry || !['100644', '100755', '120000'].includes(entry.mode)) return fail('tracked ordinary/symlink Git blob required');
    const bytes = git(['cat-file', 'blob', entry.oid]);
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
    if(realpathSync(checkout)!==root||git(['rev-parse','HEAD']).toString().trim()!==sourceSha||git(['status','--porcelain','--untracked-files=all']).length!==0)fail('clean exact source checkout changed');
  });artifactCheckouts.set(artifact, Object.freeze({root,source:capability})); return capability;
}
