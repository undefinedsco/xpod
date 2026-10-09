import { runAfs } from './entry';
import { handleCliError } from '@undefineds.co/xpod-cli/client';
runAfs(process.argv.slice(2)).catch(error => handleCliError(error, process.argv.includes('--json'), 'module_failed'));
