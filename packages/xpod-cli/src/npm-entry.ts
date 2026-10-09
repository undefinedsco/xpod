import { runCli } from './core';
import { handleCliError } from './lib/output';
const [major, minor, patch] = (process.versions.bun ?? process.versions.node).split('.').map(Number);
if (process.versions.bun ? major < 1 || (major === 1 && (minor < 3 || (minor === 3 && patch < 8))) : major < 22) {
  throw new Error('Xpod CLI requires Bun >= 1.3.8 or Node.js >= 22');
}
runCli(process.argv.slice(2)).then(code => { process.exitCode = code; })
  .catch(error => handleCliError(error, process.argv.includes('--json'), 'module_failed'));
