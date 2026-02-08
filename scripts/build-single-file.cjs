#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (error) {
    console.error('[build:single] Missing dependency: esbuild');
    console.error('Run `yarn add -D esbuild` if your environment does not provide it transitively.');
    throw error;
  }

  const repoRoot = process.cwd();
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  const external = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    ...Object.keys(packageJson.dependencies || {}),
  ]);

  const outFile = path.join(repoRoot, 'dist', 'xpod.single.cjs');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src', 'main.ts')],
    outfile: outFile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    legalComments: 'none',
    external: [...external],
    logLevel: 'info',
  });

  fs.chmodSync(outFile, 0o755);
  console.log(`[build:single] created ${path.relative(repoRoot, outFile)}`);
}

main().catch((error) => {
  console.error('[build:single] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
