import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const linxRoot = path.resolve(root, '../linx-applet-packages');

const packageSpecs = {
  '@undefineds.co/solid-sdk': '^0.1.0',
  '@undefineds.co/shared-ui': '^0.1.0',
  '@undefineds.co/extension-sdk': '^0.1.0',
  '@undefineds.co/ai-connection': '^0.1.0',
} as const;

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      CI: '1',
    },
    maxBuffer: 1024 * 1024 * 20,
  });
  return `${stdout}${stderr}`;
}

function assertRegistrySemver(specifier: unknown, packageName: string): asserts specifier is string {
  expect(specifier, `${packageName} must be declared`).toBe(packageSpecs[packageName as keyof typeof packageSpecs]);
  expect(specifier, `${packageName} must not use a local source specifier`).not.toMatch(/^(file|link|workspace):|\/Users\//);
}

describe('packaged applet SDK consumption', () => {
  it('declares applet SDK packages as registry semver dependencies only', async () => {
    const manifest = await readJson('ui/package.json');

    for (const [packageName] of Object.entries(packageSpecs)) {
      assertRegistrySemver(manifest.dependencies?.[packageName], packageName);
    }

    const sourceFiles = [
      'ui/package.json',
      'ui/tsconfig.app.json',
      'ui/vite.config.ts',
    ];

    for (const relativePath of sourceFiles) {
      const source = await readRepoFile(relativePath);
      expect(source, relativePath).not.toMatch(/file:\/Users|link:|workspace:|\/Users\/ganlu\/develop|src\/external\/linx|@linx\//);
    }
  });

  it('resolves public ESM exports from packed tarballs in an isolated consumer', async () => {
    const manifest = await readJson('ui/package.json');
    for (const [packageName] of Object.entries(packageSpecs)) {
      assertRegistrySemver(manifest.dependencies?.[packageName], packageName);
    }

    const packResult = await run('node', ['scripts/pack-applet-sdk.mjs'], linxRoot);
    const { tarballs } = JSON.parse(packResult.slice(packResult.indexOf('{'))) as { tarballs: string[] };
    expect(tarballs).toHaveLength(Object.keys(packageSpecs).length);

    const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-sdk-consumer-'));
    try {
      await writeFile(path.join(consumerRoot, 'package.json'), JSON.stringify({
        name: 'xpod-sdk-consumer-probe',
        private: true,
        type: 'module',
        dependencies: Object.fromEntries(
          tarballs.map((tarball) => {
            const packageName = packageNameFromTarball(tarball);
            return [packageName, `file:${tarball}`];
          }),
        ),
        devDependencies: {
          '@types/react': '^19.2.5',
          '@types/react-dom': '^19.2.3',
          typescript: '~5.9.3',
          vite: '^7.2.4',
          react: '19.2.6',
          'react-dom': '19.2.6',
        },
      }, null, 2));

      await mkdir(path.join(consumerRoot, 'src'), { recursive: true });
      await writeFile(path.join(consumerRoot, 'src', 'probe.tsx'), [
        "import { createElement } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import { AppLayout, AuthBoundary, TwoPaneLayout } from '@undefineds.co/extension-sdk/react';",
        "import { defineAppletLayout } from '@undefineds.co/extension-sdk';",
        "import { createAiConnectionExtension } from '@undefineds.co/ai-connection';",
        "import { SolidRuntimeProvider } from '@undefineds.co/solid-sdk/react';",
        '',
        'const extension = createAiConnectionExtension();',
        'const layout = defineAppletLayout({ type: "single-pane", render: () => null });',
        'const authBoundary = createElement(AuthBoundary, { state: { status: "authenticated" }, login: () => undefined, children: "ok" });',
        'const appLayout = createElement(AppLayout, { navigation: null, children: authBoundary });',
        'const workspace = createElement(TwoPaneLayout, { list: null, main: null });',
        'const runtime = createElement(SolidRuntimeProvider, { value: { session: null as never, pod: null as never }, children: appLayout });',
        'createRoot(document.createElement("div")).render(createElement("main", null, runtime, workspace, extension.manifest.name, layout.type));',
      ].join('\n'));
      await writeFile(path.join(consumerRoot, 'index.html'), '<div id="root"></div><script type="module" src="/src/probe.tsx"></script>');
      await writeFile(path.join(consumerRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src'],
      }, null, 2));

      await run('npm', ['install', '--no-save', '--legacy-peer-deps'], consumerRoot);
      await run('npx', ['tsc', '-p', 'tsconfig.json'], consumerRoot);
      await run('npx', ['vite', 'build'], consumerRoot);
    } finally {
      await rm(consumerRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

function packageNameFromTarball(tarball: string): string {
  const filename = path.basename(tarball);
  if (filename.startsWith('undefineds.co-solid-sdk-')) {
    return '@undefineds.co/solid-sdk';
  }
  if (filename.startsWith('undefineds.co-shared-ui-')) {
    return '@undefineds.co/shared-ui';
  }
  if (filename.startsWith('undefineds.co-extension-sdk-')) {
    return '@undefineds.co/extension-sdk';
  }
  if (filename.startsWith('undefineds.co-ai-connection-')) {
    return '@undefineds.co/ai-connection';
  }
  throw new Error(`Unknown applet SDK tarball name: ${filename}`);
}
