#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');
const workflowFiles = [
  'publish-qlever-runtime-sdk.yml',
  'publish-qlever-local-runtime.yml',
  'release.yml',
].filter((name) => fs.existsSync(path.join(workflowDir, name)));

if (workflowFiles.length === 0) {
  throw new Error('public GitHub build lane requires at least one workflow');
}

const violations = [];
for (const name of workflowFiles) {
  const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith('./')) {
      continue;
    }
    const separator = match[1].lastIndexOf('@');
    const revision = separator === -1 ? '' : match[1].slice(separator + 1);
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      violations.push(`${name}: action is not pinned by full commit: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(violations.join('\n'));
}

console.log(`public QLever build lane verified (${workflowFiles.length} workflows)`);
