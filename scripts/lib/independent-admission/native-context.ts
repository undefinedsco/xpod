import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { verifyPhysicalNativeMaterials } from '../physical-module-native';
import { collectedArtifactView } from './artifact-collector';
import type { CollectedArtifactCapability, NativeMaterialCapability, NativeMaterialView } from './artifact-contract';

const issued = new WeakMap<object, () => NativeMaterialView>();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Independent native context: ' + message); };

/** Revalidates roots on every lookup; a stale path-bearing capability cannot
 * bless subsequent filesystem changes. This is material integrity only. */
export function nativeMaterialView(value: unknown): NativeMaterialView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value)?.() : undefined;
}

export function collectNativeMaterialContext(artifact: CollectedArtifactCapability, input: {
  productRoot: string; materialsRoot: string; indexPath?: string;
}): NativeMaterialCapability {
  const view = collectedArtifactView(artifact);
  if (!view) return fail('collected artifact capability required');
  if (!view.identity.target) return fail('collected platform artifact required');
  const productRoot = realpathSync(input.productRoot), materialsRoot = realpathSync(input.materialsRoot);
  if (productRoot !== path.resolve(input.productRoot) || materialsRoot !== path.resolve(input.materialsRoot)) fail('canonical native roots required');
  const indexPath = input.indexPath ?? 'provenance/native/index.json';
  const indexed = view.members.find(row => row.path === indexPath);
  if (!indexed) return fail('native index absent from collected product');
  const verify = (): NativeMaterialView => {
    const expected = new Map(view.members.map(row => [row.path, row]));
    const directories = new Set<string>();
    for (const name of expected.keys()) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    const seen = new Set<string>();
    const walk = (relative = ''): void => {
      const directory = path.join(productRoot, relative);
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail('product root/link changed');
      for (const name of readdirSync(directory)) {
        const item = relative ? relative + '/' + name : name, file = path.join(productRoot, item), stat = lstatSync(file);
        if (stat.isSymbolicLink()) fail('native product link rejected');
        if (stat.isDirectory()) {
          if (!directories.has(item)) fail('unbound native product directory');
          walk(item); continue;
        }
        const member = expected.get(item);
        if (!stat.isFile() || !member || stat.size !== member.bytes || (stat.mode & 0o7777) !== member.mode
          || hash(readFileSync(file)) !== member.sha256) fail('native product differs from collected archive');
        seen.add(item);
      }
    };
    walk();
    if (seen.size !== expected.size) fail('native product member missing');
    const result = verifyPhysicalNativeMaterials(productRoot, { materialsRoot, indexPath });
    return Object.freeze({ identity: view.identity, productRoot, materialsRoot, indexPath,
      indexSha256: indexed.sha256, status: result.status, externalAdmission: result.externalAdmission });
  };
  verify();
  const capability = Object.freeze({}) as NativeMaterialCapability;
  issued.set(capability, verify); return capability;
}
