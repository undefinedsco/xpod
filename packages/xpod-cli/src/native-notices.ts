import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './manifest';
import { bunCompileTarget } from './native-target';

export interface NativeNoticeIndex {
  schemaVersion: number;
  target: string;
  status: string;
  packages: { name: string; version: string; files: { object: string; sha256: string }[] }[];
  runtimeNotices?: {
    toolchain: string;
    compilerCommit: string;
    scope: string;
    files: { object: string; sha256: string }[];
  };
}

/** A partial collection stays partial; copying originals does not grant release clearance. */
export function copyNativeNotices(collection: string, destination: string, target: string, compiler?: { toolchain: string; commit: string }): string[] {
  bunCompileTarget(target);
  const filename = `${target}.json`;
  const index = JSON.parse(readFileSync(path.join(collection, filename), 'utf8')) as NativeNoticeIndex;
  if (index.schemaVersion !== 1 || index.target !== target || !Array.isArray(index.packages)) {
    throw new Error('Invalid native notice index');
  }
  if (!index.runtimeNotices || !/^nightly-\d{4}-\d{2}-\d{2}$/.test(index.runtimeNotices.toolchain) ||
    !/^[a-f0-9]{40}$/.test(index.runtimeNotices.compilerCommit) || !Array.isArray(index.runtimeNotices.files) || !index.runtimeNotices.files.length ||
    (compiler !== undefined && (index.runtimeNotices.toolchain !== compiler.toolchain || index.runtimeNotices.compilerCommit !== compiler.commit))) {
    throw new Error('Invalid native runtime notice provenance');
  }
  const objects = new Map<string, string>();
  for (const files of [...index.packages.map((entry) => entry.files), index.runtimeNotices.files]) {
    for (const file of files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.object !== `objects/${file.sha256}.txt`) {
        throw new Error('Unsafe notice object');
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
