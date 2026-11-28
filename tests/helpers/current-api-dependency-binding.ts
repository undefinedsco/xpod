import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readFrozenTracked } from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';

/** Current API recipes use checkout dependency originals. Historical assertions keep their captures. */
export function readCurrentApiDependencyBinding(repoRoot: string, name: string): Buffer {
  if (name === 'package.json' || name === 'bun.lock' || name === 'packages/xpod-api/package.json') {
    return readFileSync(path.join(repoRoot, name));
  }
  return readFrozenTracked(repoRoot, name);
}

export function shaCurrentApiDependencyBinding(repoRoot: string, name: string): string {
  return createHash('sha256').update(readCurrentApiDependencyBinding(repoRoot, name)).digest('hex');
}
