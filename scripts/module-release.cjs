#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../packages/xpod-cli/src/module-catalog.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function parseTag(tag) {
  const match = /^([a-z][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?)$/.exec(tag ?? '');
  if (!match || (match[1] !== 'cli' && !Object.hasOwn(catalog, match[1]))) throw Error('module_tag_invalid');
  return { id: match[1], version: match[2], channel: match[2].includes('-') ? 'next' : 'latest' };
}
function inventory(root) {
  const files = [];
  function visit(relative) {
    const absolute = path.join(root, relative); const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error('module_release_link_rejected');
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    else if (stat.isFile()) files.push({ path: relative, sha256: hash(fs.readFileSync(absolute)), mode: stat.mode & 0o777 });
    else throw Error('module_release_file_invalid');
  }
  for (const file of ['package.json', 'LICENSE', 'README.md', 'dist']) visit(file);
  return hash(JSON.stringify(files));
}
function verifyReview(review, expected, repository) {
  if (review?.schemaVersion !== 1 || review.status !== 'verified' || review.module !== expected.id || review.version !== expected.version || review.contentSha256 !== expected.contentSha256) throw Error('module_release_review_missing_or_changed');
  for (const kind of ['licenses', 'source', 'gateway']) {
    const proof = review.evidence?.find(item => item.kind === kind);
    if (!proof || proof.status !== 'verified' || !/^[a-f0-9]{64}$/.test(proof.sha256) || typeof proof.path !== 'string' || path.isAbsolute(proof.path) || proof.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw Error('module_release_evidence_missing');
    const file = path.join(repository, proof.path);
    const relative = path.relative(fs.realpathSync(repository), fs.realpathSync(file));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('module_release_evidence_escaped');
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== proof.sha256) throw Error('module_release_evidence_changed');
  }
}
function prepare(tag, repository = process.cwd(), evidenceRoot = '.test-data/cli-package') {
  const metadata = parseTag(tag);
  // Module owners have not delivered these platform packages yet. Never publish the server under their names.
  if (metadata.id !== 'cli') throw Error(`module_artifact_not_ready:${catalog[metadata.id].packagePrefix}`);
  const pkgRoot = path.join(repository, evidenceRoot, 'source/packages/xpod-cli');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json')));
  const result = JSON.parse(fs.readFileSync(path.join(repository, evidenceRoot, 'result.json')));
  if (pkg.name !== '@undefineds.co/xpod-cli' || pkg.version !== metadata.version || result.version !== metadata.version || result.status !== 'passed' || result.kind !== 'isolated-cli-build-and-tarball-consumer' || result.optionalRuntimeDownloaded !== false || result.productionDependencies !== 0 || !['bun', 'node'].every(runtime => result.runtimes.includes(runtime))) throw Error('module_release_acceptance_invalid');
  const artifact = path.join(repository, evidenceRoot, 'xpod-cli.tgz');
  const expected = { ...metadata, package: pkg.name, contentSha256: inventory(pkgRoot), artifactSha256: hash(fs.readFileSync(artifact)) };
  // This is a reviewed statement with hash-bound evidence, not a conversion of partial notice collection into clearance.
  const reviewFile = path.join(repository, 'packages/xpod-cli/licenses/release-review.json');
  if (!fs.existsSync(reviewFile)) throw Error(`module_release_review_required:${expected.contentSha256}`);
  verifyReview(JSON.parse(fs.readFileSync(reviewFile)), expected, repository);
  return expected;
}
if (require.main === module) {
  const expected = prepare(process.env.MODULE_TAG);
  const root = '.test-data/module-release'; fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync('.test-data/cli-package/xpod-cli.tgz', `${root}/package.tgz`);
  fs.writeFileSync(`${root}/release.json`, JSON.stringify({ ...expected, sourceSha: process.env.SOURCE_SHA }, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `channel=${expected.channel}\n`);
}
module.exports = { parseTag, inventory, verifyReview, prepare };
