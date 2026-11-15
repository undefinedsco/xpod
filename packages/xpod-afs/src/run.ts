import { runAfs } from './entry';
import { handleCliError } from '@undefineds.co/xpod-cli/output';
runAfs(process.argv.slice(2)).catch(error => handleCliError(error, process.argv.includes('--json'), 'module_failed'));
