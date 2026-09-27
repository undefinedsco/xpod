/**
 * The version this deployment reports.
 *
 * One entry point, because two callers ask the same question and neither should read the package
 * manifest itself: the CLI prints it (`--version`, the completion banner) and the federation
 * `/version` endpoint answers peers with it. A second reader would be a second answer the day one
 * of them is changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from './package-root';

let cached: string | undefined;

/** The version from the package manifest, read once. `unknown` when it cannot be read at all. */
export function deploymentVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version?: string };
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}

/** The implementation name this deployment reports to peers. */
export const IMPLEMENTATION_NAME = 'xpod';
