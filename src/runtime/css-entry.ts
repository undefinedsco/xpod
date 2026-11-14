#!/usr/bin/env node
import './configure-drizzle-solid';
import { createErrorMessage } from '@solid/community-server';
import { PACKAGE_ROOT } from './package-root';
import { bindPackagedCssNativeRuntime } from './css-native-runtime';
import { runCssCli } from './css-main';

Promise.resolve().then(() => {
  bindPackagedCssNativeRuntime(PACKAGE_ROOT);
  return runCssCli(process.argv, { isolatedDependencies: true });
}).catch((error: unknown) => {
  // Component discovery can fail before a LoggerFactory exists. Follow the
  // CSS CLI stderr contract so early startup failures remain observable.
  process.stderr.write(`CSS startup failed: ${createErrorMessage(error)}\n`);
  process.exitCode = 1;
});
