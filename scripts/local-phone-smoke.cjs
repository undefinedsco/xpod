#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {
    port: process.env.XPOD_PHONE_SMOKE_PORT || '3000',
    env: '.env.local',
    config: 'config/local.json',
    ip: process.env.XPOD_PHONE_SMOKE_IP || '',
    path: process.env.XPOD_PHONE_SMOKE_PATH || '/.well-known/openid-configuration',
    storagePath: process.env.XPOD_PHONE_SMOKE_STORAGE_PATH || '.data/inrupt-smoke/probe.ttl#this',
    nodeId: process.env.XPOD_PHONE_SMOKE_NODE_ID || '',
    spBaseUrl: process.env.XPOD_PHONE_SMOKE_SP_BASE_URL || process.env.XPOD_PHONE_SMOKE_PUBLIC_BASE_URL || '',
    idpBaseUrl: process.env.XPOD_PHONE_SMOKE_IDP_BASE_URL || '',
    print: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--print' || arg === '--dry-run') options.print = true;
    else if (arg === '--port' || arg === '-p') options.port = next();
    else if (arg.startsWith('--port=')) options.port = arg.slice('--port='.length);
    else if (arg === '--ip') options.ip = next();
    else if (arg.startsWith('--ip=')) options.ip = arg.slice('--ip='.length);
    else if (arg === '--path') options.path = next();
    else if (arg.startsWith('--path=')) options.path = arg.slice('--path='.length);
    else if (arg === '--storage-path') options.storagePath = next();
    else if (arg.startsWith('--storage-path=')) options.storagePath = arg.slice('--storage-path='.length);
    else if (arg === '--node-id') options.nodeId = next();
    else if (arg.startsWith('--node-id=')) options.nodeId = arg.slice('--node-id='.length);
    else if (arg === '--sp-base-url' || arg === '--public-base-url') options.spBaseUrl = next();
    else if (arg.startsWith('--sp-base-url=')) options.spBaseUrl = arg.slice('--sp-base-url='.length);
    else if (arg.startsWith('--public-base-url=')) options.spBaseUrl = arg.slice('--public-base-url='.length);
    else if (arg === '--idp-base-url') options.idpBaseUrl = next();
    else if (arg.startsWith('--idp-base-url=')) options.idpBaseUrl = arg.slice('--idp-base-url='.length);
    else if (arg === '--env' || arg === '-e') options.env = next();
    else if (arg.startsWith('--env=')) options.env = arg.slice('--env='.length);
    else if (arg === '--config' || arg === '-c') options.config = next();
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log(`Usage: node scripts/local-phone-smoke.cjs [options]

Starts xpod local so a phone on the same Wi-Fi can verify local reachability.

Options:
  --ip <address>      LAN IPv4 address to advertise. Auto-detected by default.
  --port, -p <port>   Gateway port. Default: 3000.
  --path <path>       Resource path prefilled in the browser verifier. Default: /.well-known/openid-configuration.
  --storage-path <path>
                     Storage-relative RDF resource for drizzle-solid smoke writes. Default: .data/inrupt-smoke/probe.ttl#this.
  --node-id <id>      Node ID prefilled in the signaling verifier.
  --sp-base-url <url>
                     Public HTTP(S) SP origin routed to this local node.
  --idp-base-url <url>
                     Cloud IdP origin for registration/login/OIDC issuer.
  --public-base-url <url>
                     Alias for --sp-base-url.
  --env, -e <file>    Env file passed to xpod. Default: .env.local.
  --config, -c <file> Config file passed to xpod. Default: config/local.json.
  --print             Print command and URLs without starting xpod.
  --help, -h          Show this help.
`);
}

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  const preferredNames = ['en0', 'en1', 'eth0', 'wlan0'];

  for (const name of preferredNames) {
    for (const address of interfaces[name] || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        return address.address;
      }
    }
  }

  return '';
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const ip = options.ip || detectLanIp();
  if (!ip) {
    throw new Error('Unable to detect LAN IPv4. Pass --ip <address>.');
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  const envPath = resolvePath(options.env);
  const configPath = resolvePath(options.config);
  const localBaseUrl = `http://${ip}:${port}`;
  const spBaseUrl = normalizePublicBaseUrl(options.spBaseUrl, '--sp-base-url');
  const idpBaseUrl = normalizePublicBaseUrl(options.idpBaseUrl, '--idp-base-url');
  const accessBaseUrl = spBaseUrl || `${localBaseUrl}/`;
  const identityBaseUrl = idpBaseUrl || accessBaseUrl;
  const runtimeBaseUrl = spBaseUrl || localBaseUrl;
  const phoneUrl = accessBaseUrl;
  const registerUrl = new URL('/.account/login/password/register/', identityBaseUrl).toString();
  const loginUrl = new URL('/.account/login/password/', identityBaseUrl).toString();
  const accountUrl = new URL('/.account/', identityBaseUrl).toString();
  const resourcePath = normalizeResourcePath(options.path);
  const storagePath = normalizeStoragePath(options.storagePath);
  const verifierUrl = new URL('/app/reachability.html', accessBaseUrl);
  verifierUrl.searchParams.set('path', resourcePath);
  const resourceUrl = new URL(resourcePath, accessBaseUrl).toString();
  const signalVerifierUrl = new URL('/app/signal-pod.html', accessBaseUrl);
  signalVerifierUrl.searchParams.set('path', resourcePath);
  if (options.nodeId.trim()) {
    signalVerifierUrl.searchParams.set('nodeId', options.nodeId.trim());
  }
  const inruptVerifierBaseUrl = spBaseUrl && idpBaseUrl ? identityBaseUrl : accessBaseUrl;
  const inruptVerifierUrl = new URL('/app/inrupt-smoke.html', inruptVerifierBaseUrl);
  inruptVerifierUrl.searchParams.set('issuer', identityBaseUrl);
  if (spBaseUrl && idpBaseUrl) {
    inruptVerifierUrl.searchParams.set('storagePath', storagePath);
  } else {
    inruptVerifierUrl.searchParams.set('sp', resourceUrl);
    inruptVerifierUrl.searchParams.set('storagePath', storagePath);
  }
  const healthUrl = new URL('/.well-known/openid-configuration', accessBaseUrl).toString();
  const args = [
    'src/main.ts',
    '--env', envPath,
    '--config', configPath,
    '--host', '0.0.0.0',
    '--port', String(port),
  ];

  console.log('Xpod local phone smoke');
  console.log(`  LAN IP:       ${ip}`);
  console.log(`  Local URL:    ${localBaseUrl}/`);
  if (spBaseUrl && !idpBaseUrl) console.log(`  Public URL:   ${spBaseUrl}`);
  if (spBaseUrl && idpBaseUrl) {
    console.log(`  Public SP URL: ${spBaseUrl}`);
    console.log(`  Cloud IdP URL: ${idpBaseUrl}`);
  }
  console.log(`  Phone URL:    ${phoneUrl}`);
  if (spBaseUrl && idpBaseUrl) {
    console.log(`  Register URL:  ${registerUrl}`);
    console.log(`  Login URL:     ${loginUrl}`);
    console.log(`  Account URL:   ${accountUrl}`);
  } else if (spBaseUrl) {
    console.log(`  Register URL: ${registerUrl}`);
    console.log(`  Login URL:    ${loginUrl}`);
    console.log(`  Account URL:  ${accountUrl}`);
  }
  console.log(`  Verifier URL: ${verifierUrl.toString()}`);
  console.log(`  Signal URL:   ${signalVerifierUrl.toString()}`);
  console.log(`  Inrupt URL:   ${inruptVerifierUrl.toString()}`);
  console.log(`  Storage Path: ${storagePath}`);
  console.log(`  Resource URL: ${resourceUrl}`);
  console.log(`  Health URL:   ${healthUrl}`);
  console.log(`  Base URL:     ${runtimeBaseUrl}`);
  console.log(`  Bind host:    0.0.0.0`);
  console.log(`  Env file:     ${envPath}`);
  console.log(`  Config file:  ${configPath}`);
  console.log('');
  if (spBaseUrl && idpBaseUrl) {
    console.log('Phone registers/logs in on the Cloud IdP URL, then accesses Pod resources through the public SP URL.');
  } else if (spBaseUrl) {
    console.log('Phone can use the public URL from cellular/external networks when Cloud ingress routes to this local node.');
  } else {
    console.log('Phone must be on the same Wi-Fi. If it cannot open the URL, check macOS firewall and router client isolation.');
  }
  console.log('');
  const commandEnv = [`CSS_BASE_URL=${runtimeBaseUrl}`];
  if (idpBaseUrl) commandEnv.push(`oidcIssuer=${idpBaseUrl}`);
  console.log(`Command: ${commandEnv.join(' ')} bun ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);

  if (options.print) return;

  const childEnv = {
    ...process.env,
    CSS_BASE_URL: runtimeBaseUrl,
  };
  if (idpBaseUrl) childEnv.oidcIssuer = idpBaseUrl;

  const child = spawn('bun', args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: childEnv,
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}


function normalizePublicBaseUrl(value, optionName = '--public-base-url') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${optionName} protocol: ${parsed.protocol}`);
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${optionName} must be an origin, for example https://node-0000.undefineds.co/`);
  }
  parsed.pathname = '/';
  return parsed.toString();
}

function normalizeResourcePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '/.well-known/openid-configuration';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeStoragePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '.data/inrupt-smoke/probe.ttl#this';
  if (/^https?:\/\//iu.test(trimmed)) {
    const parsed = new URL(trimmed);
    return `${parsed.pathname.replace(/^\/+/, '')}${parsed.hash}` || '.data/inrupt-smoke/probe.ttl#this';
  }
  return trimmed.replace(/^\/+/, '') || '.data/inrupt-smoke/probe.ttl#this';
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
