import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './manifest';
import { bunCompileTarget } from './native-target';

export interface NativeNoticeIndex {
  schemaVersion: number;
  target: string;
  status: string;
  packages: { name: string; version: string; files: { object: string; sha256: string }[] }[];
}

/** A partial collection stays partial; copying originals does not grant release clearance. */
export function copyNativeNotices(collection: string, destination: string, target: string): string[] {
  bunCompileTarget(target);
  const filename = `${target}.json`;
  const index = JSON.parse(readFileSync(path.join(collection, filename), 'utf8')) as NativeNoticeIndex;
  if (index.schemaVersion !== 1 || index.target !== target || !Array.isArray(index.packages)) {
    throw new Error('Invalid native notice index');
  }
  const objects = new Map<string, string>();
  for (const entry of index.packages) {
    for (const file of entry.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.object !== `objects/${file.sha256}.txt`) {
        throw new Error(`Unsafe notice object: ${entry.name}`);
      }
      objects.set(file.object, file.sha256);
    }
  }
  // Validate the whole input before creating output, so drift never yields a
  // superficially successful partial install bundle.
  for (const [object, sha] of objects) {
    if (sha256File(path.join(collection, object)) !== sha) { throw new Error(`Native notice hash mismatch: ${object}`); }
  }
  mkdirSync(path.join(destination, 'objects'), { recursive: true });
  cpSync(path.join(collection, filename), path.join(destination, filename));
  for (const object of objects.keys()) { cpSync(path.join(collection, object), path.join(destination, object)); }
  return [filename, ...objects.keys()];
}
