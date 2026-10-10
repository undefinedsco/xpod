#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
// The client bridge is still used by the server: auth/client/build changes are shared.
const CLI_ONLY = [
  'packages/xpod-cli/src/core.ts', 'packages/xpod-cli/src/npm-entry.ts',
  'packages/xpod-cli/src/module-catalog.ts', 'packages/xpod-cli/src/module-catalog.json', 'packages/xpod-cli/src/module-store.ts',
  'packages/xpod-cli/tests/module-store.test.ts', 'packages/xpod-cli/tsconfig.core.json',
  'scripts/check-cli-package.cjs', '.github/workflows/cli-package.yml',
  '.github/workflows/module-release.yml', 'scripts/module-release.cjs',
];
function classify(paths, fallback = false) {
  const result = { cli: fallback, service: fallback, css: fallback, api: fallback, afs: fallback };
  for (const filename of paths) {
    if (CLI_ONLY.includes(filename)) { result.cli = true; continue; }
    if (/^(?:docs\/|.*\.md$)/.test(filename) && !['AGENTS.md', 'docs/RELEASE.md'].includes(filename)) continue;
    // Unknown paths and shared dependencies deliberately select the full service gate.
    result.service = true;
    result.css = true; result.api = true; result.afs = true; result.cli = true;
  }
  return result;
}
function changedPaths(base, head, run = execFileSync) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base) || !/^[a-f0-9]{40}$/.test(head ?? '')) return { paths: [], fallback: true };
  try { return { paths: run('git', ['diff', '--no-renames', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean), fallback: false }; }
  catch { return { paths: [], fallback: true }; }
}
function checkRequired(needs) {
  if (needs.impact?.result !== 'success' || needs.contracts?.result !== 'success') throw new Error('CI routing/contract checks failed');
  for (const name of ['cli', 'service']) if (!['true', 'false'].includes(needs.impact.outputs?.[name])) throw new Error('Missing CI impact output');
  const expected = [...(needs.impact.outputs.cli === 'true' ? ['cli'] : []), ...(needs.impact.outputs.service === 'true' ? ['test', 'integration-lite', 'integration-full', 'bun-runtime', 'package-smoke', 'package-smoke-bun'] : [])];
  for (const name of expected) if (needs[name]?.result !== 'success') throw new Error(`Required CI gate failed or skipped: ${name}`);
}
function syncCandidate(filename = '.github/workflows/candidate.yml') {
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('    paths-ignore:\n');
  const end = source.indexOf('\n  workflow_dispatch:', start);
  if (start < 0 || end < 0) throw new Error('Candidate routing markers missing');
  const generated = '    paths-ignore:\n      # Generated from module-ci.cjs CLI_ONLY; run node scripts/module-ci.cjs sync.\n' + CLI_ONLY.map(file => `      - '${file}'`).join('\n') + '\n';
  fs.writeFileSync(filename, source.slice(0, start) + generated + source.slice(end));
}
if (require.main === module) {
  if (process.argv[2] === 'sync') syncCandidate();
  else if (process.argv[2] === 'required') checkRequired(JSON.parse(process.env.NEEDS_JSON));
  else {
    const changed = changedPaths(process.env.BASE_SHA, process.env.HEAD_SHA);
    const result = classify(changed.paths, changed.fallback);
    console.log(JSON.stringify({ ...result, changedPaths: changed.paths, fallback: changed.fallback }));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
}
module.exports = { CLI_ONLY, classify, changedPaths, checkRequired, syncCandidate };
