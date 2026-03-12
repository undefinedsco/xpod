import fs from 'node:fs';
import path from 'node:path';

export function findPackageRoot(dir: string): string {
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
