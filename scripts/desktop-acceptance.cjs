#!/usr/bin/env node
/** The mandatory desktop gate requires both real self-update and permission operations. */
const fs = require('node:fs');
const { verifyEvidence: verifySelfUpdate } = require('./desktop-self-update-acceptance.cjs');
const { verifyEvidence: verifyPermissions, describeArchive, bundledRuntimeHash } = require('./desktop-permission-acceptance.cjs');

function verifyDesktopAcceptance(records, expected) {
  const update = verifySelfUpdate(records?.selfUpdate, { sourceSha: expected.sourceSha, newVersion: expected.version,
    newZipSha256: expected.archive.sha256, newZipSize: expected.archive.size, requireNameVersion: true });
  const permission = verifyPermissions(records?.permissions, expected);
  const errors = [
    ...update.errors.map(error => ({ ...error, path: `selfUpdate.${error.path}` })),
    ...permission.errors.map(error => ({ ...error, path: `permissions.${error.path}` })),
  ];
  return { valid: errors.length === 0, errors };
}

async function main(argv) {
  const args = {};
  const allowed = new Set(['--self-update-evidence', '--permission-evidence', '--source-sha', '--version', '--expected-archive', '--checks-out']);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(args, argv[i])) {
      throw new Error('invalid desktop gate arguments');
    }
    args[argv[i]] = argv[i + 1];
  }
  for (const key of allowed) if (!args[key]) throw new Error('missing desktop gate argument');
  const { AI_CONNECTIONS_SERVICE_RESOURCE_IDS } = require('@undefineds.co/ai-connections/service-access-resources');
  const result = verifyDesktopAcceptance({
    selfUpdate: JSON.parse(fs.readFileSync(args['--self-update-evidence'], 'utf8')),
    permissions: JSON.parse(fs.readFileSync(args['--permission-evidence'], 'utf8')),
  }, { sourceSha: args['--source-sha'], version: args['--version'],
    archive: await describeArchive(args['--expected-archive']),
    runtimeBinarySha256: await bundledRuntimeHash(args['--expected-archive']),
    resourceIds: AI_CONNECTIONS_SERVICE_RESOURCE_IDS });
  if (result.valid) fs.writeFileSync(args['--checks-out'], JSON.stringify({ desktop: 'passed' }) + '\n');
  console.log(JSON.stringify(result));
  return result.valid ? 0 : 1;
}

module.exports = { verifyDesktopAcceptance };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(() => { console.error('combined desktop acceptance verification failed'); process.exitCode = 1; });
