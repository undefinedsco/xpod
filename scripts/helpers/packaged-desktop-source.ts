import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const execute = promisify(execFile);
const { applyPlatformOptionalDependencies } = createRequire(import.meta.url)('../platform-binaries.cjs') as {
  applyPlatformOptionalDependencies(value: Record<string, unknown>, version: string): void;
};

/** Release CI applies only the existing version/native dependency transformation.
 * Generated build directories are outputs; every other changed/untracked file
 * prevents this runner from claiming that its product source is the frozen SHA.
 */
export async function verifyPackagedSourceCheckout(input: { cwd: string; sourceSha: string; version: string }): Promise<void> {
  const git = async (...args: string[]): Promise<string> => (await execute('git', args, { cwd: input.cwd })).stdout;
  if ((await git('rev-parse', 'HEAD')).trim() !== input.sourceSha) throw new Error('Runner checkout does not match artifact source');
  const changed = (await git('diff', '--name-only', '-z', input.sourceSha)).split('\0').filter(Boolean);
  const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  for (const file of new Set([...changed, ...untracked])) {
    if (['dist/', 'static/app/', 'static/dashboard/', 'static/settings/', 'components/', 'desktop/dist/', 'desktop/release/']
      .some(directory => file.startsWith(directory))) continue;
    if (['desktop/runtime-pack.json', 'desktop/runtime-pack-budget.json'].includes(file)) continue;
    if (file !== 'package.json' && file !== 'desktop/package.json') throw new Error('Uncommitted source prevents exact-source desktop acceptance');
    const baseline = JSON.parse(await git('show', `${input.sourceSha}:${file}`)) as Record<string, unknown>;
    const current = JSON.parse(await readFile(path.join(input.cwd, file), 'utf8')) as Record<string, unknown>;
    const expected: Record<string, unknown> = { ...baseline, version: input.version };
    if (file === 'package.json') applyPlatformOptionalDependencies(expected, input.version);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Checkout differs from the existing release version transformation');
  }
  for (const file of ['package.json', 'desktop/package.json']) {
    if ((JSON.parse(await readFile(path.join(input.cwd, file), 'utf8')) as { version?: string }).version !== input.version) {
      throw new Error('Checkout version differs from the artifact');
    }
  }
}
