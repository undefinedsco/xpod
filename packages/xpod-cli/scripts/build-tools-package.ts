import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicTools } from './public-build-tools';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dependencyRoot = root;
while (!existsSync(path.join(dependencyRoot, 'node_modules'))) {
  const parent = path.dirname(dependencyRoot);
  if (parent === dependencyRoot) throw new Error('CLI build dependencies missing');
  dependencyRoot = parent;
}
buildPublicTools(root, dependencyRoot);
