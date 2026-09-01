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
  const distTagViews = new Map<string, string | undefined>();
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

    if (file === 'npm' && args[0] === 'view' && args[2]?.startsWith('dist-tags.')) {
      const tag = args[2].slice('dist-tags.'.length);
      return JSON.stringify(distTagViews.get(tag) ?? null);
    }

    if (file === 'npm' && args[0] === 'dist-tag' && args[1] === 'add') {
      distTagViews.set(args[3], args[2].split('@').at(-1));
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

  it('keeps platform dependencies in the root package when platform packages were published separately', async () => {
    const root = await makePackageRepo('1.2.3-rc.9');
    const commands: Command[] = [];
    const baseRunner = createRunner(commands);
    let packEnv: NodeJS.ProcessEnv | undefined;

    main([ '--dry-run', '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      runFile: (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        if (file === process.execPath && args[0]?.endsWith('run-npm-pack.cjs')) {
          packEnv = options.env;
        }
        return baseRunner(file, args, options);
      },
    });

    expect(packEnv?.XPOD_INCLUDE_PLATFORM_PACKAGES).toBe('true');
    expect(commands.some((command) =>
      command.file === process.execPath && command.args[0]?.endsWith('publish-platform-packages.cjs')
    )).toBe(false);
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

  it('repairs a stale explicit next dist-tag when the candidate version already exists', async () => {
    const root = await makePackageRepo('1.2.3-rc.9');
    const commands: Command[] = [];

    main([ '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_TAG: 'next',
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      readPublishedVersion: () => '1.2.3-rc.9',
      runFile: createRunner(commands),
    });

    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'npm', args: [ 'view', '@undefineds.co/xpod', 'dist-tags.next', '--json', '--registry', 'https://registry.npmjs.org' ]}),
      expect.objectContaining({ file: 'npm', args: [ 'dist-tag', 'add', '@undefineds.co/xpod@1.2.3-rc.9', 'next', '--registry', 'https://registry.npmjs.org' ]}),
    ]));
    expect(commands.filter((command) => command.file === 'npm' && command.args[0] === 'view' && command.args[2] === 'dist-tags.next')).toHaveLength(2);
    expect(JSON.stringify(commands)).not.toContain('npm dist-tag add ');
  });

  it('accepts an npm dist-tag race when the final tag already points to the candidate', async () => {
    const root = await makePackageRepo('1.2.3-rc.9');
    let viewCount = 0;
    const baseRunner = createRunner([]);

    expect(() => main([ '--skip-build' ], {
      cwd: root,
      env: {
        XPOD_PUBLISH_TAG: 'next',
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      readPublishedVersion: () => '1.2.3-rc.9',
      runFile: (file: string, args: string[]) => {
        if (file === 'npm' && args[0] === 'view' && args[2] === 'dist-tags.next') {
          viewCount += 1;
          return JSON.stringify(viewCount === 1 ? '1.2.3-rc.8' : '1.2.3-rc.9');
        }
        if (file === 'npm' && args[0] === 'dist-tag') {
          throw new Error('next is already set to version 1.2.3-rc.9');
        }
        return baseRunner(file, args, {});
      },
    })).not.toThrow();
  });

  it('relies on npm publish --tag after a successful publish and does not manage tags for stable implicit publishes', async () => {
    const rcRoot = await makePackageRepo('1.2.3-rc.10');
    const rcCommands: Command[] = [];

    main([ '--skip-build' ], {
      cwd: rcRoot,
      env: {
        XPOD_PUBLISH_TAG: 'next',
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      readPublishedVersion: () => undefined,
      runFile: createRunner(rcCommands),
    });

    const publishIndex = rcCommands.findIndex((command) => command.file === 'npm' && command.args[0] === 'publish');
    expect(publishIndex).toBeGreaterThan(-1);
    expect(rcCommands.some((command) => command.file === 'npm' && command.args[0] === 'dist-tag')).toBe(false);

    const stableRoot = await makePackageRepo('1.2.3');
    const stableCommands: Command[] = [];
    main([ '--skip-build' ], {
      cwd: stableRoot,
      env: {
        XPOD_PUBLISH_PLATFORM_PACKAGES: 'false',
      },
      readPublishedVersion: () => undefined,
      runFile: createRunner(stableCommands),
    });

    expect(stableCommands.some((command) => command.file === 'npm' && command.args[0] === 'dist-tag')).toBe(false);
    expect(stableCommands.some((command) => command.file === 'npm' && command.args[0] === 'view' && command.args[2]?.startsWith('dist-tags.'))).toBe(false);
  });
});
