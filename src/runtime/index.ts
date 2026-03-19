import path from 'path';
import fs from 'fs';

/** xpod package root: walk up from __dirname until we find package.json */
function findPackageRoot(dir: string): string {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return dir;
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);

export { GatewayProxy } from './Proxy';
export { getFreePort } from './port-finder';
export { applyEnv, loadEnvFile } from './env-utils';
export { registerSocketFetchOrigin } from './socket-fetch';
export { registerSocketOriginShims } from './socket-shim';
export { startXpodRuntime } from './XpodRuntime';
export type { XpodRuntimeOptions, XpodRuntimeHandle } from './XpodRuntime';
