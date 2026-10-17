import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = process.cwd();
const object = 'packages/xpod-cli/licenses/javascript/objects/7610d223851f421d315df5e77974f1c68a04b97e02060e5bbbcf13d95e3ca257.txt';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

it('preserves original license index and checkout bytes with autocrlf enabled, while reproducing the unprotected mismatch', async () => {
  const parent = path.join(root, '.test-data/git-original-materials');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'checkout-'));
  const git = (...args: string[]): Buffer => {
    const result = spawnSync('git', args, { cwd: directory,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'absent-global-config') } });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout;
  };
  try {
    git('init', '--quiet');
    git('config', 'core.autocrlf', 'true');
    git('config', 'core.safecrlf', 'false');
    const original = await readFile(path.join(root, object));
    const expected = path.basename(object, '.txt');
    expect(sha(original)).toBe(expected);
    await mkdir(path.dirname(path.join(directory, object)), { recursive: true });
    await writeFile(path.join(directory, object), original);
    git('add', '--', object);
    expect(git('show', `:${object}`)).toEqual(original);
    await rm(path.join(directory, object));
    git('checkout-index', '--force', '--', object);
    const converted = await readFile(path.join(directory, object));
    expect(sha(converted)).not.toBe(expected);
    expect(converted).toEqual(Buffer.from(original.toString().replace(/\n/gu, '\r\n')));

    // Re-add from original input after installing the real repository attributes.
    await writeFile(path.join(directory, '.gitattributes'), await readFile(path.join(root, '.gitattributes')));
    await writeFile(path.join(directory, object), original);
    const mixedPath = 'packages/fixture/licenses/nested/original.txt';
    const mixed = Buffer.from('first\r\nsecond\nlast\r\n');
    await mkdir(path.dirname(path.join(directory, mixedPath)), { recursive: true });
    await writeFile(path.join(directory, mixedPath), mixed);
    git('add', '--', '.gitattributes', object, mixedPath);
    for (const [file, bytes] of [[object, original], [mixedPath, mixed]] as const) {
      expect(git('show', `:${file}`)).toEqual(bytes);
      expect(git('check-attr', 'text', '--', file).toString().trim()).toBe(`${file}: text: unset`);
      await rm(path.join(directory, file));
      git('checkout-index', '--force', '--', file);
      expect(await readFile(path.join(directory, file))).toEqual(bytes);
    }
    expect(git('check-attr', 'text', '--', 'packages/fixture/src/index.ts').toString().trim())
      .toBe('packages/fixture/src/index.ts: text: unspecified');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
