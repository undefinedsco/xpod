import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicTools } from './public-build-tools';
import { cliBuildDependencyLayout, buildDependencyRootArgument } from '../src/build-dependency-layout';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
buildPublicTools(root, cliBuildDependencyLayout(root, buildDependencyRootArgument(process.argv.slice(2))).repoRoot);
