const path = require('node:path');
const { canonicalMember } = require('./mode-evidence-reader.cjs');
const PROFILES = Object.freeze({ renew: Object.freeze({ accessTokenTtl: 30, refreshTokenTtl: 180 }), idle: Object.freeze({ accessTokenTtl: 30, refreshTokenTtl: 180 }), expire: Object.freeze({ accessTokenTtl: 30, refreshTokenTtl: 5 }) });
const SHA = /^[a-f0-9]{64}$/;
const count = value => Number.isSafeInteger(value) && value >= 0;
function requireFact(fact, message) { if (!fact) throw new Error(message); }
function ownedPath(root, value) {
  requireFact(typeof root === 'string' && path.isAbsolute(root) && typeof value === 'string', 'Owned path required');
  const relative = path.relative(root, path.resolve(value));
  requireFact(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path outside owned root');
}
function validSources(row) {
  return row && Object.keys(row).length > 0 && Object.keys(row).length <= 64 && Object.entries(row).every(([key, value]) => (['bun.lock', 'docker-compose.acceptance.yml'].includes(key) || /^(?:tests|scripts|packages|desktop|ui)\//.test(key)) && canonicalMember(key) && SHA.test(value));
}
function validateInput(row) {
  requireFact(row.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(row.sourceSha), 'Session source required');
  requireFact(['cloud', 'local', 'standalone'].includes(row.mode), 'Session mode invalid');
  requireFact(/^.+@sha256:[a-f0-9]{64}$/.test(row.image?.reference) && ['linux/amd64', 'linux/arm64'].includes(row.image.platform) && /^sha256:[a-f0-9]{64}$/.test(row.image.id), 'Session immutable image required');
  for (const value of [row.baseUrl, row.issuer]) { const u = new URL(value); requireFact(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && u.port && Number(u.port) !== 60895 && !u.username && !u.password && !u.search && !u.hash, 'Owned session URL required'); }
  requireFact(row.mode === 'local' ? new URL(row.issuer).origin !== new URL(row.baseUrl).origin : row.issuer === row.baseUrl, 'Session issuer topology mismatch');
  const profile = PROFILES[row.profile?.kind];
  requireFact(profile && row.profile.accessTokenTtl === profile.accessTokenTtl && row.profile.refreshTokenTtl === profile.refreshTokenTtl && SHA.test(row.profile.originalConfigSHA256) && SHA.test(row.profile.derivedConfigSHA256), 'Session policy required');
  requireFact(typeof row.binding?.webId === 'string' && typeof row.binding?.podUrl === 'string', 'Authoritative binding required');
  const identity = new URL(row.binding.webId); const storage = new URL(row.binding.podUrl);
  requireFact(identity.origin === new URL(row.issuer).origin && ['http:', 'https:'].includes(storage.protocol) && storage.pathname.endsWith('/') && !storage.username && !storage.password && !storage.search && !storage.hash, 'Authoritative resource binding invalid');
  ownedPath(row.ownershipRoot, row.accountFile); ownedPath(row.ownershipRoot, row.outputDirectory);
  return row;
}
function validateReceipt(row, input) {
  validateInput(input);
  requireFact(row.schemaVersion === 1 && row.status === 'passed', 'Session not passed');
  for (const key of ['sourceSha', 'mode']) requireFact(row[key] === input[key], 'Session binding mismatch');
  for (const key of ['reference', 'platform', 'id']) requireFact(row.image?.[key] === input.image[key], 'Session image mismatch');
  for (const key of ['kind', 'accessTokenTtl', 'refreshTokenTtl', 'originalConfigSHA256', 'derivedConfigSHA256']) requireFact(row.profile?.[key] === input.profile[key], 'Session policy mismatch');
  requireFact(row.binding?.webId === input.binding.webId && row.binding?.podUrl === input.binding.podUrl, 'Session identity mismatch');
  requireFact(count(row.browser?.authorizationCodes) && row.browser.authorizationCodes >= 2 && row.browser.passwordPosts === 1 && row.browser.cookieRestored === true && row.browser.identityMatches === true, 'Real browser restoration missing');
  const sdk = row.sdk;
  requireFact(count(sdk?.authorizationCodes) && sdk.authorizationCodes >= 1 && sdk.persistedHostRestored === true && sdk.identityMatches === true && sdk.privateReadWrite === true && sdk.anonymousDenied === true, 'Real SDK restoration missing');
  if (input.profile.kind === 'expire') requireFact(count(sdk.refreshRejections) && sdk.refreshRejections > 0 && sdk.authorizationCodes >= 2 && sdk.refreshExpiryObserved === true && sdk.recoveredByLogin === true, 'Actual refresh expiry/relogin missing');
  else requireFact(count(sdk.refreshSuccesses) && sdk.refreshSuccesses > 0 && sdk.accessExpiryObserved === true, 'Actual refresh grant missing');
  requireFact(row.lifecycle?.exitCode === 0 && ['waitKnown', 'closeObserved', 'groupAbsent'].every(k => row.lifecycle[k] === true), 'Session lifecycle incomplete');
  requireFact(row.cleanup?.hostAbsent === true && row.cleanup.rpClosed === true && row.cleanup.privateStateRemoved === true, 'Session cleanup incomplete');
  requireFact(Array.isArray(row.originals) && row.originals.length > 0 && row.originals.length <= 32 && new Set(row.originals.map(x => x.path)).size === row.originals.length && row.originals.every(x => canonicalMember(x.path) && x.path !== 'session.safe.json' && SHA.test(x.sha256) && Number.isSafeInteger(x.bytes) && x.bytes >= 0 && x.bytes <= 1048576), 'Session safe originals missing');
  requireFact(validSources(row.sources), 'Session source hashes missing');
  return row;
}
module.exports = { PROFILES, validateInput, validateReceipt, validSources };
