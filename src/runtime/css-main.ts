import { createRequire } from 'node:module';
import path from 'node:path';
import { PACKAGE_ROOT } from './package-root';
import { ensureSupportedBun } from './compat/ensureSupportedBun';
import { ensureBunUndiciCompat, ensureBunCommunitySolidServerJwkCompat } from './compat/ensureBunUndiciCompat';
import { createPackageRootPreferredAppRunner, type CssModuleLoaderOptions } from './runner/node/CommunitySolidServerCssRunner';

/** Canonical CSS process startup, shared by the service host and CSS module. */
export async function runCssCli(argv: string[] = process.argv, options: CssModuleLoaderOptions = {}): Promise<void> {
  ensureSupportedBun();
  ensureBunUndiciCompat();
  const css = process.env.XPOD_BUN_SINGLE_RUNTIME === '1'
    ? createRequire(path.join(PACKAGE_ROOT, 'package.json'))(path.join(PACKAGE_ROOT, 'node_modules/@solid/community-server/dist/__bundle__.cjs')) as typeof import('@solid/community-server')
    : await import('@solid/community-server');
  ensureBunCommunitySolidServerJwkCompat(css);
  await createPackageRootPreferredAppRunner(css.AppRunner, PACKAGE_ROOT, options).runCli(argv);
}
