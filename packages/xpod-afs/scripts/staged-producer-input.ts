import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { resolveProducerInput } from './producer-input';
type Input = ReturnType<typeof resolveProducerInput>;

/** Preserve a complete verified build artifact inside the collector's actual staging boundary. */
export async function withStagedProducerInput<T>(input: Input, parent: string, operation: (staged: Input) => Promise<T>): Promise<T> {
  const inventory = (root: string): Map<string, string> => {
    const files = new Map<string, string>();
    const walk = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const file = path.join(directory, name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('Build producer artifact contains a symlink');
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) files.set(path.relative(root, file), `${stat.mode & 0o777}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`);
        else throw new Error('Build producer artifact contains nonregular material');
      }
    };
    walk(root); return files;
  };
  input.assertCurrent(); const expected = inventory(input.root);
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'producer-cli-')), root = path.join(directory, 'package');
  const verify = (): void => {
    input.assertCurrent();
    for (const candidate of [input.root, root]) {
      const actual = inventory(candidate);
      if (actual.size !== expected.size || [...expected].some(([file, hash]) => actual.get(file) !== hash)) throw new Error('Build producer artifact inventory changed');
    }
  };
  const project = (file: string): string => path.join(root, path.relative(input.root, file));
  try {
    cpSync(input.root, root, { recursive: true, dereference: false }); verify();
    const result = await operation(Object.freeze({ ...input, root, indexPath: project(input.indexPath), toolsPath: project(input.toolsPath),
      assertCurrent: verify, resolveImport: (subpath: string) => { const file = project(input.resolveImport(subpath)); verify(); return file; } }));
    verify(); return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
