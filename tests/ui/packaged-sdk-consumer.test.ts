import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const commandTimeoutMs = 60_000;
const tarballDir = process.env.XPOD_APPLET_PACKAGE_TARBALL_DIR;
const registryUrl = process.env.XPOD_APPLET_PACKAGE_REGISTRY_URL;
const consumerIntegrationIt = tarballDir || registryUrl ? it : it.skip;

const packageSpecs = {
  '@undefineds.co/solid-sdk': '^0.1.0',
  '@undefineds.co/shared-ui': '^0.1.0',
  '@undefineds.co/extension-sdk': '^0.1.0',
  '@undefineds.co/ai-connections': '^0.1.0',
} as const;

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function run(command: string, args: string[], cwd: string, context: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: '1',
      },
      maxBuffer: 1024 * 1024 * 20,
      timeout: commandTimeoutMs,
      killSignal: 'SIGTERM',
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    throw new Error(`${context} failed while running ${command} ${args.join(' ')} in ${cwd}`, {
      cause: error,
    });
  }
}

function assertRegistrySemver(specifier: unknown, packageName: string): asserts specifier is string {
  expect(specifier, `${packageName} must be declared`).toBe(packageSpecs[packageName as keyof typeof packageSpecs]);
  expect(specifier, `${packageName} must not use a local source specifier`).not.toMatch(/^(file|link|workspace):|\/Users\//);
}

function assertWorkspaceDependency(specifier: unknown, packageName: string): asserts specifier is string {
  expect(specifier, `${packageName} must be declared`).toBe('workspace:*');
}

async function resolvePackageInputs(): Promise<Record<string, string>> {
  if (tarballDir) {
    return dependenciesFromTarballs(tarballDir);
  }
  return { ...packageSpecs };
}

async function dependenciesFromTarballs(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory);
  const tarballs = entries
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => path.resolve(directory, entry));
  const dependencies = Object.fromEntries(
    tarballs.map((tarball) => [packageNameFromTarball(tarball), `file:${tarball}`]),
  );

  expect(Object.keys(dependencies).sort()).toEqual(Object.keys(packageSpecs).sort());
  return dependencies;
}

describe('packaged applet SDK consumption', () => {
  it('does not depend on a mutable sibling Linx checkout for default tests', async () => {
    const testSource = await readRepoFile('tests/ui/packaged-sdk-consumer.test.ts');
    const siblingPath = ['..', 'linx-applet-packages'].join('/');
    const legacyPeerFlag = ['--legacy', 'peer-deps'].join('-');

    expect(testSource).not.toContain(siblingPath);
    expect(testSource).not.toContain(legacyPeerFlag);
  });

  it('declares editable applet SDK packages from the Xpod workspace', async () => {
    const manifest = await readJson('ui/package.json');

    for (const [packageName] of Object.entries(packageSpecs)) {
      assertWorkspaceDependency(manifest.dependencies?.[packageName], packageName);
    }

    const sourceFiles = [
      'ui/tsconfig.app.json',
      'ui/vite.config.ts',
    ];

    for (const relativePath of sourceFiles) {
      const source = await readRepoFile(relativePath);
      expect(source, relativePath).not.toMatch(/file:\/Users|link:|workspace:|\/Users\/ganlu\/develop|src\/external\/linx|@linx\//);
    }
  });

  it('bundles the renamed AI connections workspace package into release tarballs', async () => {
    const packScript = await readRepoFile('scripts/run-npm-pack.cjs');

    expect(packScript).toContain("'@undefineds.co/ai-connections'");
    expect(packScript).not.toContain("'@undefineds.co/ai-connection'");
  });

  consumerIntegrationIt('resolves public ESM exports when XPOD_APPLET_PACKAGE_TARBALL_DIR or XPOD_APPLET_PACKAGE_REGISTRY_URL is configured', async () => {
    const manifest = await readJson('ui/package.json');
    for (const [packageName] of Object.entries(packageSpecs)) {
      assertWorkspaceDependency(manifest.dependencies?.[packageName], packageName);
    }

    const consumerRoot = await mkdtemp(path.join(os.tmpdir(), 'xpod-sdk-consumer-'));
    try {
      const dependencies = await resolvePackageInputs();
      await writeFile(path.join(consumerRoot, 'package.json'), JSON.stringify({
        name: 'xpod-sdk-consumer-probe',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: {
          '@types/react': '^19.2.5',
          '@types/react-dom': '^19.2.3',
          typescript: '~5.9.3',
          vite: '^7.2.4',
          react: '^19.2.0',
          'react-dom': '^19.2.0',
        },
      }, null, 2));
      if (registryUrl) {
        await writeFile(path.join(consumerRoot, '.npmrc'), `@undefineds.co:registry=${registryUrl}\n`);
      }

      await mkdir(path.join(consumerRoot, 'src'), { recursive: true });
      await writeFile(path.join(consumerRoot, 'src', 'probe.tsx'), [
        "import '@undefineds.co/shared-ui/theme.css';",
        "import { createElement } from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import { AppLayout, SolidAuthBoundary, TwoPaneLayout } from '@undefineds.co/extension-sdk/react';",
        "import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing';",
        "import { defineAppletLayout } from '@undefineds.co/extension-sdk/web';",
        "import { createAiConnectionsExtension } from '@undefineds.co/ai-connections';",
        "import { aiConnectionManifest } from '@undefineds.co/ai-connections/manifest';",
        "import { createSolidSessionRuntime } from '@undefineds.co/solid-sdk';",
        "import { SolidRuntimeProvider } from '@undefineds.co/solid-sdk/react';",
        '',
        'const extension = createAiConnectionsExtension();',
        'const host = createMockWebExtensionHost();',
        'const solidRuntimeSession = createSolidSessionRuntime();',
        'const layout = defineAppletLayout({ type: "single-pane", render: () => null });',
        'const authBoundary = createElement(SolidAuthBoundary, { state: { status: "anonymous" }, routes: [{ id: "identity-only", label: "Identity only", identityProvider: { url: "https://id.example", label: "Identity" }, availability: "ready" }], onLogin: () => undefined, children: "ok" });',
        'const appLayout = createElement(AppLayout, { navigation: null, children: authBoundary });',
        'const workspace = createElement(TwoPaneLayout, { list: null, main: null });',
        'const runtime = createElement(SolidRuntimeProvider, { value: { session: solidRuntimeSession }, children: appLayout });',
        'createRoot(document.createElement("div")).render(createElement("main", null, runtime, workspace, extension.manifest.name, aiConnectionManifest.name, layout.type));',
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

      await run('npm', ['install', '--no-save'], consumerRoot, 'installing applet SDK consumer dependencies');
      await run('npx', ['tsc', '-p', 'tsconfig.json'], consumerRoot, 'typechecking applet SDK consumer probe');
      await run('npx', ['vite', 'build'], consumerRoot, 'building applet SDK consumer probe');
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
  if (filename.startsWith('undefineds.co-ai-connections-')) {
    return '@undefineds.co/ai-connections';
  }
  throw new Error(`Unknown applet SDK tarball name: ${filename}`);
}
