#!/usr/bin/env node

const { readFile, writeFile } = require('node:fs/promises');
const process = require('node:process');
const { parse, stringify } = require('yaml');

const BEGIN_MARKER = '# BEGIN XPOD RC ROUTES';
const END_MARKER = '# END XPOD RC ROUTES';
const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!['--input', '--output', '--namespace', '--config-key'].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    args[name.slice(2)] = value;
    index += 1;
  }
  if (!args.namespace || !kubernetesName.test(args.namespace) || args.namespace.length > 63) {
    throw new Error('--namespace must be a valid Kubernetes name');
  }
  return args;
}

async function readInput(inputPath) {
  if (!inputPath || inputPath === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(inputPath, 'utf8');
}

function findConfigKey(configMap, requestedKey) {
  const data = configMap.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('ConfigMap must contain string data');
  }
  if (requestedKey) {
    if (typeof data[requestedKey] !== 'string') throw new Error('Requested config key is not string data');
    return requestedKey;
  }
  const candidates = Object.entries(data)
    .filter(([, value]) => typeof value === 'string' && /\bserver\s*\{/.test(value))
    .map(([key]) => key);
  if (candidates.length !== 1) {
    throw new Error('Could not identify one nginx config entry; pass --config-key');
  }
  return candidates[0];
}

function renderServer(host, port, upstream) {
  return `server {
  listen ${port};
  server_name ${host};

  location / {
    proxy_pass ${upstream};
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
  }
}`;
}

function updateNginxConfig(existing, namespace) {
  const upstream = `http://xpod-rc.${namespace}.svc.cluster.local:80`;
  const managedBlock = [
    BEGIN_MARKER,
    renderServer('id-rc.undefineds.co', 8082, upstream),
    '',
    renderServer('pods-rc.undefineds.co', 8083, upstream),
    '',
    renderServer('api-rc.undefineds.co', 8081, upstream),
    END_MARKER,
  ].join('\n');
  const markerPattern = new RegExp(`${BEGIN_MARKER}[\\s\\S]*?${END_MARKER}`, 'g');
  if (existing.includes(BEGIN_MARKER) !== existing.includes(END_MARKER)) {
    throw new Error('nginx config contains an incomplete XPOD RC marker block');
  }
  const matches = existing.match(markerPattern) ?? [];
  if (matches.length > 1) throw new Error('nginx config contains multiple XPOD RC marker blocks');
  if (matches.length === 1) return existing.replace(markerPattern, managedBlock);
  return `${existing.trimEnd()}\n\n${managedBlock}\n`;
}

function makeApplyable(configMap) {
  const metadata = { ...(configMap.metadata ?? {}) };
  for (const key of ['creationTimestamp', 'deletionGracePeriodSeconds', 'deletionTimestamp', 'generation', 'managedFields', 'resourceVersion', 'selfLink', 'uid']) {
    delete metadata[key];
  }
  return { ...configMap, metadata };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readInput(args.input);
  const parsed = parse(raw);
  if (!parsed || parsed.kind !== 'ConfigMap') {
    throw new Error('Input must be a ConfigMap');
  }
  const configMap = makeApplyable(parsed);
  const configKey = findConfigKey(configMap, args['config-key']);
  configMap.data[configKey] = updateNginxConfig(configMap.data[configKey], args.namespace);
  const output = stringify(configMap, { lineWidth: 0 });
  if (args.output && args.output !== '-') {
    await writeFile(args.output, output, { mode: 0o600 });
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  process.stderr.write(`update-gateway-rc-configmap: ${error.message}\n`);
  process.exitCode = 1;
});
