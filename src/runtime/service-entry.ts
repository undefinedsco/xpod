#!/usr/bin/env node
import { ensureSupportedBun } from './compat/ensureSupportedBun';
import './configure-drizzle-solid';
import yargs from 'yargs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PACKAGE_ROOT } from './package-root';

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
    const { ensureBunUndiciCompat, ensureBunCommunitySolidServerJwkCompat } = await import('./compat/ensureBunUndiciCompat');
    ensureBunUndiciCompat();
    const css = process.env.XPOD_BUN_SINGLE_RUNTIME === '1'
      ? createRequire(path.join(PACKAGE_ROOT, 'package.json'))(path.join(PACKAGE_ROOT, 'node_modules/@solid/community-server/dist/__bundle__.cjs')) as typeof import('@solid/community-server')
      : await import('@solid/community-server');
    ensureBunCommunitySolidServerJwkCompat(css);
    const { createPackageRootPreferredAppRunner } = await import('./runner/node/CommunitySolidServerCssRunner');
    await createPackageRootPreferredAppRunner(css.AppRunner, PACKAGE_ROOT).runCli(process.argv);
    return;
  }
  const { startCommand } = await import('../cli/commands/start');
  await yargs(args).scriptName('xpod-service').command(startCommand).demandCommand(1).strict().help().version().parseAsync();
}

main().catch((error: unknown) => {
  console.error('Service startup failed:', error);
  process.exitCode = 1;
});
