import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts/publish-release.cjs');
const platformBinariesPath = path.join(repoRoot, 'scripts/platform-binaries.cjs');
const { main } = require(scriptPath);
const { applyPlatformOptionalDependencies } = require(platformBinariesPath);

const tempRoots: string[] = [];

type Command = {
  file: string;
  args: string[];
};

async function makePackageRepo(version: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-publish-release-'));
  tempRoots.push(root);
  const packageJson = applyPlatformOptionalDependencies({
    name: '@undefineds.co/xpod',
    version,
    optionalDependencies: {},
  }, version);

  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await mkdir(path.join(root, '.test-data/npm-pack'), { recursive: true });
  return root;
}

function createRunner(commands: Command[]) {
  return (file: string, args: string[], options: { cwd?: string }) => {
    commands.push({ file, args: [ ...args ]});

    if (file === process.execPath && args[0]?.endsWith('run-npm-pack.cjs')) {
      const packDir = args[1];
      const packJsonPath = path.join(packDir, 'pack.json');
      const tarballName = 'undefineds.co-xpod-1.2.3.tgz';
      require('node:fs').writeFileSync(packJsonPath, JSON.stringify([{ filename: tarballName }]));
      require('node:fs').writeFileSync(path.join(packDir, tarballName), 'tarball');
    }

    if (file === process.execPath && args[0]?.endsWith('check-pack-json.cjs')) {
      const packJsonPath = args[1];
      JSON.parse(require('node:fs').readFileSync(packJsonPath, 'utf8'));
    }

    return '';
  };
}

describe('publish-release npm dist-tag handling', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses XPOD_PUBLISH_TAG=next instead of prerelease inference and passes it as an npm argv token', async () => {
    const root = await makePackageRepo('1.2.3-beta.4');
    const commands: Command[] = [];

    main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_TAG: 'next',
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
        XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      },
      runFile: createRunner(commands),
    });

    const publish = commands.find((command) => command.file === 'npm' && command.args[0] === 'publish');
    expect(publish).toBeDefined();
    expect(publish?.args).toEqual(expect.arrayContaining([ '--tag', 'next', '--dry-run' ]));
    expect(publish?.args).not.toContain('beta');
    expect(publish?.args).not.toContain('next --otp=123456');
    expect(publish?.args[publish.args.indexOf('--tag') + 1]).toBe('next');
  });

  it('keeps the existing prerelease dist-tag inference when XPOD_PUBLISH_TAG is unset', async () => {
    const root = await makePackageRepo('1.2.3-rc.9');
    const commands: Command[] = [];

    main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
        XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      },
      runFile: createRunner(commands),
    });

    const publish = commands.find((command) => command.file === 'npm' && command.args[0] === 'publish');
    expect(publish?.args).toEqual(expect.arrayContaining([ '--tag', 'rc' ]));
  });

  it('does not add a dist-tag for stable versions when XPOD_PUBLISH_TAG is unset', async () => {
    const root = await makePackageRepo('1.2.3');
    const commands: Command[] = [];

    main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
        XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      },
      runFile: createRunner(commands),
    });

    const publish = commands.find((command) => command.file === 'npm' && command.args[0] === 'publish');
    expect(publish?.args).not.toContain('--tag');
  });

  it.each([
    '1.2.3',
    'next tag',
    '--tag=latest',
    'next --otp=123456',
    'next\nlatest',
    '.hidden',
    '',
  ])('rejects unsafe XPOD_PUBLISH_TAG value %j before npm publish', async (tag) => {
    const root = await makePackageRepo('1.2.3-rc.9');
    const commands: Command[] = [];

    expect(() => main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_TAG: tag,
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
        XPOD_PUBLISH_REGISTRY: 'https://registry.npmjs.org',
      },
      runFile: createRunner(commands),
    })).toThrow(/XPOD_PUBLISH_TAG/);

    expect(commands.some((command) => command.file === 'npm' && command.args[0] === 'publish')).toBe(false);
  });

  it('does not interpolate the dist-tag through a shell command string', async () => {
    const root = await makePackageRepo('1.2.3-rc.9');
    const commands: Command[] = [];

    main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_TAG: 'next',
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      runFile: createRunner(commands),
    });

    const serializedCommands = JSON.stringify(commands);
    expect(serializedCommands).not.toContain('npm publish ');
    expect(commands.find((command) => command.file === 'npm')?.args).toContain('next');
    await expect(readFile(path.join(root, 'package.json'), 'utf8')).resolves.toContain('"version": "1.2.3-rc.9"');
  });
});
