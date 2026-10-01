#!/usr/bin/env bun
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNativeSources } from '../src/native-sources';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let upstream: string | undefined;
let destination: string | undefined;
let offline = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--upstream') { upstream = path.resolve(process.argv[++i]); }
  else if (arg === '--out') { destination = path.resolve(process.argv[++i]); }
  else if (arg === '--offline') { offline = true; }
  else { throw new Error(`Unknown argument: ${arg}`); }
}
if (!upstream || !destination) { throw new Error('Provide --upstream <fixed Git checkout> --out <fresh native-source directory> [--offline]'); }
const kit = exportNativeSources({ repoRoot, upstream, destination, offline });
console.log(JSON.stringify({ directory: destination, engine: kit.engine, toolchain: kit.toolchain, registryPackages: kit.registryPackages, files: kit.files.length, scope: kit.scope }));
