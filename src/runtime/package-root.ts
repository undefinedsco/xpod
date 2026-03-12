import { nodeRuntimePlatform } from './platform/node/NodeRuntimePlatform';
import type { RuntimePlatform } from './platform/types';

export function findPackageRoot(
  dir: string,
  platform: Pick<RuntimePlatform, 'dirname' | 'joinPath' | 'fileExists'> = nodeRuntimePlatform,
): string {
  let current = dir;
  while (current !== platform.dirname(current)) {
    if (platform.fileExists(platform.joinPath(current, 'package.json'))) {
      return current;
    }
    current = platform.dirname(current);
  }
  return dir;
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);
