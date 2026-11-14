#!/usr/bin/env node
import { ensureSupportedBun } from './compat/ensureSupportedBun';
import './configure-drizzle-solid';
import yargs from 'yargs';

/** Service process entry: startup and its supervised internal children only. */
async function main(): Promise<void> {
  ensureSupportedBun();
  const args = process.argv.slice(2);
  if (args[0] === '__internal-api') {
    await import('../api/main');
    return;
  }
  if (args[0] === '__internal-css') {
    process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
    const { runCssCli } = await import('./css-main');
    await runCssCli(process.argv);
    return;
  }
  const { startCommand } = await import('../cli/commands/start');
  await yargs(args).scriptName('xpod-service').command(startCommand).demandCommand(1).strict().help().version().parseAsync();
}

main().catch((error: unknown) => {
  console.error('Service startup failed:', error);
  process.exitCode = 1;
});
