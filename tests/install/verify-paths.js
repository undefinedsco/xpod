/**
 * 验证 xpod 编译产物中所有路径解析是否正确。
 * 用法: node tests/install/verify-paths.js
 * 需要先 yarn build:ts
 */
const path = require('path');
const fs = require('fs');
const { PACKAGE_ROOT } = require('../../dist/runtime');

let failures = 0;

function check(label, filePath, shouldExist) {
  const exists = fs.existsSync(filePath);
  const ok = exists === shouldExist;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${filePath}`);
  if (!ok) failures++;
}

console.log(`PACKAGE_ROOT = ${PACKAGE_ROOT}\n`);

console.log('[只读资源 - PACKAGE_ROOT]');
check('config/local.json', path.join(PACKAGE_ROOT, 'config/local.json'), true);
check('static/app/', path.join(PACKAGE_ROOT, 'static/app'), true);
check('static/dashboard/', path.join(PACKAGE_ROOT, 'static/dashboard'), true);
check('package.json', path.join(PACKAGE_ROOT, 'package.json'), true);

console.log('\n[dist 内部路径 - __dirname]');
// main.ts 编译后 __dirname = dist/, path.join(__dirname, 'api', 'main.js') = dist/api/main.js
const distDir = path.join(PACKAGE_ROOT, 'dist');
check('api/main.js (from main.ts __dirname)', path.join(distDir, 'api', 'main.js'), true);
// start.ts 编译后 __dirname = dist/cli/commands/, resolve(.., .., api, main.js) = dist/api/main.js
const fromStart = path.resolve(distDir, 'cli', 'commands', '..', '..', 'api', 'main.js');
check('api/main.js (from start.ts __dirname)', fromStart, true);

console.log('\n[CSS binary - require.resolve]');
try {
  const cssBin = require.resolve('@solid/community-server/bin/server.js');
  check('CSS binary', cssBin, true);
  const cssRoot = path.dirname(require.resolve('@solid/community-server/package.json'));
  check('CSS module root', cssRoot, true);
} catch (e) {
  console.log(`  ✗ require.resolve failed: ${e}`);
  failures++;
}

console.log('\n[可写数据 - process.cwd()]');
console.log(`  cwd = ${process.cwd()}`);
console.log(`  logs → ${path.join(process.cwd(), 'logs')}`);
console.log(`  .xpod/runtime → ${path.join(process.cwd(), '.xpod/runtime')}`);

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures);
