const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { collectModuleTests } = require('./test-runner-ownership.cjs');
const root = path.resolve(__dirname, '..');
const groupIndex = process.argv.indexOf('--group');
const selected = groupIndex < 0 ? undefined : process.argv[groupIndex + 1];
if (groupIndex >= 0 && !selected) throw new Error('--group requires an owned group');
const files = collectModuleTests(root, selected);
if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ bun: files.bun.map(f => path.relative(root, f)), node: files.node.map(f => path.relative(root, f)) }, null, 2));
} else {
  let failed = false;
  for (const runner of ['bun', 'node']) {
    if (!files[runner].length) continue;
    console.log(`[module-tests] ${runner}: ${files[runner].length} actual test files`);
    const args = runner === 'bun' ? ['test', ...files.bun] : ['--import', pathToFileURL(path.join(__dirname, 'register-node-module-test-loader.mjs')).href, '--test', ...files.node];
    const result = spawnSync(runner, args, { cwd: process.cwd(), stdio: 'inherit', env: process.env });
    if (result.error) console.error(result.error);
    if (result.status !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
