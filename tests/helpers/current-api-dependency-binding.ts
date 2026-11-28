import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shaFrozenTracked } from '../fixtures/independent-admission/cli17-accepted-419/frozen-metadata';

/** Current API recipes use checkout dependency originals. Historical assertions keep their captures. */
export function shaCurrentApiDependencyBinding(repoRoot: string, name: string): string {
  if (name === 'package.json' || name === 'bun.lock' || name === 'packages/xpod-api/package.json') {
    return createHash('sha256').update(readFileSync(path.join(repoRoot, name))).digest('hex');
  }
  return shaFrozenTracked(repoRoot, name);
}
