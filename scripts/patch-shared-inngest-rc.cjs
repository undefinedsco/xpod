#!/usr/bin/env node
const fs = require('node:fs');

const RC_EVENT_KEY_ENV = 'XPOD_RC_INNGEST_EVENT_KEY';
const RC_EVENT_KEY_ARG = `\$(${RC_EVENT_KEY_ENV})`;
const RC_SDK_URL = 'http://xpod-rc/api/inngest';

function readArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error(`invalid argument near ${name ?? '<end>'}`);
    result[name.slice(2)] = value;
  }
  for (const name of [ 'input', 'output', 'secret-name' ]) {
    if (!result[name]) throw new Error(`--${name} is required`);
  }
  return result;
}

function removeFlagValue(args, flag, value) {
  const next = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] === value) {
      index += 1;
      continue;
    }
    next.push(args[index]);
  }
  return next;
}

function patchDeployment(input, secretName) {
  if (input?.kind !== 'Deployment' || input?.metadata?.name !== 'xpod-inngest') {
    throw new Error('input must be Deployment/xpod-inngest');
  }
  const output = structuredClone(input);
  const container = output.spec?.template?.spec?.containers?.find((entry) => entry.name === 'inngest');
  if (!container) throw new Error('Deployment/xpod-inngest must contain container/inngest');

  container.env = (container.env ?? []).filter((entry) => entry.name !== RC_EVENT_KEY_ENV);
  container.env.push({
    name: RC_EVENT_KEY_ENV,
    valueFrom: { secretKeyRef: { name: secretName, key: 'XPOD_INNGEST_EVENT_KEY' } },
  });

  let args = removeFlagValue(container.args ?? [], '--event-key', RC_EVENT_KEY_ARG);
  args = removeFlagValue(args, '--sdk-url', RC_SDK_URL);
  args.push('--event-key', RC_EVENT_KEY_ARG, '--sdk-url', RC_SDK_URL);
  container.args = args;

  output.metadata = {
    name: output.metadata.name,
    namespace: output.metadata.namespace,
    ...(output.metadata.labels ? { labels: output.metadata.labels } : {}),
    ...(output.metadata.annotations ? { annotations: output.metadata.annotations } : {}),
  };
  delete output.status;
  return output;
}

function main(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const output = patchDeployment(input, args['secret-name']);
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[patch-shared-inngest-rc] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { patchDeployment };
