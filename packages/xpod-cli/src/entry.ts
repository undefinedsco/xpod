import { main } from './main';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.versions.bun ?? process.versions.node).split('.').map(Number);
const compatible = process.versions.bun
  ? version[0] > 1 || (version[0] === 1 && (version[1] > 3 || (version[1] === 3 && version[2] >= 8)))
  : version[0] >= 22;
if (!compatible) {
  throw new Error('Xpod CLI requires installed Bun >= 1.3.8 or Node.js >= 22');
}

// The payload and helper share an install root. Re-entering the payload with
// process.execPath (proxy/rg) retains this rule without invoking the shell.
const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../helper/agentfs-pod');
if (!process.env.XPOD_AGENTFS_HELPER && existsSync(helper)) {
  process.env.XPOD_AGENTFS_HELPER = helper;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
