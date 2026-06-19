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
    nodeId: process.env.XPOD_PHONE_SMOKE_NODE_ID || '',
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
    else if (arg === '--node-id') options.nodeId = next();
    else if (arg.startsWith('--node-id=')) options.nodeId = arg.slice('--node-id='.length);
    else if (arg === '--env' || arg === '-e') options.env = next();
    else if (arg.startsWith('--env=')) options.env = arg.slice('--env='.length);
    else if (arg === '--config' || arg === '-c') options.config = next();
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.log(`Usage: node scripts/local-phone-smoke.cjs [options]\n\nStarts xpod local so a phone on the same Wi-Fi can verify local reachability.\n\nOptions:\n  --ip <address>      LAN IPv4 address to advertise. Auto-detected by default.\n  --port, -p <port>   Gateway port. Default: 3000.\n  --path <path>       Resource path prefilled in the browser verifier. Default: /.well-known/openid-configuration.\n  --node-id <id>      Node ID prefilled in the signaling verifier.\n  --env, -e <file>    Env file passed to xpod. Default: .env.local.\n  --config, -c <file> Config file passed to xpod. Default: config/local.json.\n  --print             Print command and URLs without starting xpod.\n  --help, -h          Show this help.\n`);
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
  const baseUrl = `http://${ip}:${port}`;
  const phoneUrl = `${baseUrl}/`;
  const resourcePath = normalizeResourcePath(options.path);
  const verifierUrl = new URL('/app/reachability.html', `${baseUrl}/`);
  verifierUrl.searchParams.set('path', resourcePath);
  const resourceUrl = new URL(resourcePath, `${baseUrl}/`).toString();
  const signalVerifierUrl = new URL('/app/signal-pod.html', `${baseUrl}/`);
  signalVerifierUrl.searchParams.set('path', resourcePath);
  if (options.nodeId.trim()) {
    signalVerifierUrl.searchParams.set('nodeId', options.nodeId.trim());
  }
  const inruptVerifierUrl = new URL('/app/inrupt-smoke.html', `${baseUrl}/`);
  inruptVerifierUrl.searchParams.set('issuer', `${baseUrl}/`);
  inruptVerifierUrl.searchParams.set('sp', resourceUrl);
  const healthUrl = `${baseUrl}/.well-known/openid-configuration`;
  const args = [
    'src/main.ts',
    '--env', envPath,
    '--config', configPath,
    '--host', '0.0.0.0',
    '--port', String(port),
  ];

  console.log('Xpod local phone smoke');
  console.log(`  LAN IP:       ${ip}`);
  console.log(`  Phone URL:    ${phoneUrl}`);
  console.log(`  Verifier URL: ${verifierUrl.toString()}`);
  console.log(`  Signal URL:   ${signalVerifierUrl.toString()}`);
  console.log(`  Inrupt URL:   ${inruptVerifierUrl.toString()}`);
  console.log(`  Resource URL: ${resourceUrl}`);
  console.log(`  Health URL:   ${healthUrl}`);
  console.log(`  Base URL:     ${baseUrl}`);
  console.log(`  Bind host:    0.0.0.0`);
  console.log(`  Env file:     ${envPath}`);
  console.log(`  Config file:  ${configPath}`);
  console.log('');
  console.log('Phone must be on the same Wi-Fi. If it cannot open the URL, check macOS firewall and router client isolation.');
  console.log('');
  console.log(`Command: CSS_BASE_URL=${baseUrl} bun ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);

  if (options.print) return;

  const child = spawn('bun', args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      CSS_BASE_URL: baseUrl,
    },
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

function normalizeResourcePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '/.well-known/openid-configuration';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

try {
  main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
