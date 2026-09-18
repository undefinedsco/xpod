#!/usr/bin/env bun
/**
 * Dependency-state preflight.
 *
 * Two states break a checkout in ways that surface as dozens of unrelated test
 * failures, so both are checked before the suite runs:
 *
 *   1. A patched dependency whose patch is missing, unapplied, or applied twice
 *      (re-installing without re-extracting the package re-applies a patch and
 *      can land a hunk in the wrong object).
 *   2. A workspace package whose build output is missing, which makes every
 *      consumer fail to resolve `@undefineds.co/*` subpaths.
 *
 * Usage:
 *   bun scripts/check-dependency-state.ts            # verify (test entry point runs this)
 *   bun scripts/check-dependency-state.ts --repair   # verify; unsafe package repair is refused
 *
 * Without pristine package bytes, duplicate-looking declarations cannot be
 * distinguished safely from legitimate aliases. Drift requires reinstallation;
 * this checker never rewrites installed dependency files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repairRequested = process.argv.includes('--repair');
const failures: string[] = [];

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

interface PatchHunk {
  /** One-based position in the final patched file, not the original file. */
  newStart: number;
  newCount: number;
  /** Context plus added lines: the block as it must look after the patch. */
  postImage: string[];
}

interface PatchTarget {
  target: string;
  hunks: PatchHunk[];
}

function parsePatch(patchFile: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let current: PatchTarget | undefined;
  let kinds: string[] = [];
  let texts: string[] = [];
  let newStart = 0;
  let newCount = 0;

  const closeHunk = (): void => {
    if (!current || kinds.length === 0) {
      return;
    }
    const postImage: string[] = [];
    kinds.forEach((kind, index) => {
      const text = texts[index];
      if (kind === 'add') {
        postImage.push(text);
        return;
      }
      if (kind === 'context') {
        postImage.push(text);
      }
    });
    current.hunks.push({ newStart, newCount, postImage });
    kinds = [];
    texts = [];
  };

  for (const line of readFileSync(patchFile, 'utf8').split(/\r?\n/u)) {
    if (line.startsWith('+++ ')) {
      closeHunk();
      current = { target: line.slice(4).replace(/^[ab]\//u, '').trim(), hunks: [] };
      targets.push(current);
      continue;
    }
    if (line.startsWith('@@')) {
      closeHunk();
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      newStart = header ? Number(header[1]) : 0;
      newCount = header ? Number(header[2] ?? 1) : 0;
      continue;
    }
    if (!current || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('+')) {
      kinds.push('add');
      texts.push(line.slice(1));
    } else if (line.startsWith('-')) {
      kinds.push('remove');
      texts.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      kinds.push('context');
      texts.push(line.slice(1));
    }
  }
  closeHunk();
  return targets;
}

/**
 * Count contiguous line-block occurrences. String search with line-boundary
 * checks keeps this fast on large bundles; the naive per-line scan cost seconds
 * per test run.
 */
function countContiguous(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || haystack.length < needle.length) {
    return 0;
  }
  const text = haystack.join('\n');
  const pattern = needle.join('\n');
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(pattern, from);
    if (index < 0) {
      return count;
    }
    const startsLine = index === 0 || text[index - 1] === '\n';
    const end = index + pattern.length;
    const endsLine = end === text.length || text[end] === '\n';
    if (startsLine && endsLine) {
      count += 1;
    }
    from = index + 1;
  }
}

/**
 * Check both final positions and multiplicity. Repeated alias declarations may
 * have identical post-images, but each must occupy its own declared hunk range.
 * Hunk +line coordinates already include previous insertions/deletions.
 */
function verifyPatchApplied(packageDir: string, patchFile: string): { problem?: string } {
  const targets = parsePatch(patchFile);
  if (targets.length === 0) {
    return { problem: 'patch contains no file targets' };
  }
  for (const { target, hunks } of targets) {
    if (hunks.length === 0) {
      return { problem: `${target}: patch contains no hunks` };
    }
    const file = path.join(packageDir, target);
    if (!existsSync(file)) {
      return { problem: `${target} is missing from the installed package` };
    }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    const expected = new Map<string, { postImage: string[]; positions: Set<number> }>();
    for (const hunk of hunks) {
      if (hunk.newStart < 1 || hunk.newCount !== hunk.postImage.length || hunk.postImage.length === 0) {
        return { problem: `${target}: hunk has no verifiable target range` };
      }
      const start = hunk.newStart - 1;
      if (hunk.postImage.some((line, offset) => lines[start + offset] !== line)) {
        return { problem: `${target}: patch is missing or misplaced at target line ${hunk.newStart}` };
      }
      const key = JSON.stringify(hunk.postImage);
      const group = expected.get(key) ?? { postImage: hunk.postImage, positions: new Set<number>() };
      if (group.positions.has(start)) {
        return { problem: `${target}: duplicate hunk target at line ${hunk.newStart}` };
      }
      group.positions.add(start);
      expected.set(key, group);
    }
    for (const { postImage, positions } of expected.values()) {
      const occurrences = countContiguous(lines, postImage);
      if (occurrences !== positions.size) {
        return { problem: `${target}: hunk appears ${occurrences} times, expected ${positions.size} declared positions` };
      }
    }
  }
  return {};
}

function packageNameFromDependencyKey(key: string): string {
  const separator = key.lastIndexOf('@');
  return separator > 0 ? key.slice(0, separator) : key;
}

function checkPatchedDependencies(): void {
  const patched = readJson(path.join(root, 'package.json')).patchedDependencies ?? {};
  for (const [key, patchPath] of Object.entries<string>(patched)) {
    const name = packageNameFromDependencyKey(key);
    const directory = path.join(root, 'node_modules', name);
    const patchFile = path.join(root, patchPath);
    if (!existsSync(directory)) {
      failures.push(`${name} is not installed — run: bun install`);
      continue;
    }
    if (!existsSync(patchFile)) {
      failures.push(`patch file is missing for ${key}: ${patchPath}`);
      continue;
    }
    const installedVersion = readJson(path.join(directory, 'package.json')).version as string;
    const pinnedVersion = key.slice(key.lastIndexOf('@') + 1);
    if (installedVersion !== pinnedVersion) {
      failures.push(`${name}: installed ${installedVersion} but the patch targets ${pinnedVersion}`
        + ' — align package.json and patchedDependencies, then run: bun install');
      continue;
    }
    const before = verifyPatchApplied(directory, patchFile);
    if (!before.problem) {
      continue;
    }
    failures.push(`${key}: ${before.problem}`
      + (repairRequested
        ? ' — cannot safely repair without pristine package bytes; reinstall with: bun install'
        : ' — reinstall with: bun install'));
  }
}

// Bun's patchedDependencies and repository postinstall patches are separate.
// A --ignore-scripts reinstall restores registry bytes for the latter.
function checkPostinstallPatches(): void {
  const postinstall = readJson(path.join(root, 'package.json')).scripts?.postinstall ?? '';
  const browser = '@inrupt/solid-client-authn-browser';
  // Check both pinned 3.1.1 branches in context. A remaining occurrence in the
  // other branch must not hide a lost custom authenticated transport.
  const sessionTransportBranches = [
    'getClientAuthenticationWithDependencies({ secureStorage: sessionOptions.secureStorage, ' +
      'insecureStorage: sessionOptions.insecureStorage, fetch: sessionOptions.fetch, });',
    'getClientAuthenticationWithDependencies({ fetch: sessionOptions.fetch, });',
  ];
  const checks: Array<{ script: string; name: string; files: Array<[string, string[]]> }> = [
    {
      script: 'patch-inrupt-authn-refresh.js', name: '@inrupt/solid-client-authn-core',
      files: ['src/authenticatedFetch/fetchFactory.ts', 'dist/index.js', 'dist/index.mjs']
        .map((file) => [file, ['XPOD_REFRESH_RETRY_MAX_DELAY_MS']]),
    },
    {
      script: 'patch-inrupt-authn-transport.js', name: browser,
      files: [
        ['src/Session.ts', ['fetch?: typeof fetch;', ...sessionTransportBranches]],
        ['src/dependencies.ts', ['fetch?: typeof fetch;', 'dependencies.fetch']],
        ['src/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.ts', ['fetch: this.fetch', 'this.fetch = fetch;']],
        ['dist/index.js', [...sessionTransportBranches, 'this.fetch = fetch;', 'fetch: this.fetch', 'dependencies.fetch']],
        ['dist/index.mjs', [...sessionTransportBranches, 'this.fetch = fetch;', 'fetch: this.fetch', 'dependencies.fetch']],
        ['dist/Session.d.ts', ['fetch?: typeof fetch;']],
        ['dist/dependencies.d.ts', ['fetch?: typeof fetch;']],
        ['dist/login/oidc/incomingRedirectHandler/AuthCodeRedirectHandler.d.ts', ['fetch?: typeof fetch']],
      ].map(([file, snippets]) => [file as string, ['XPOD_INRUPT_AUTHN_BROWSER_FETCH_TRANSPORT', ...snippets as string[]]]),
    },
    {
      script: 'patch-inrupt-authn-operation-cleanup.js', name: browser,
      files: ['src/Session.ts', 'dist/index.js', 'dist/index.mjs']
        .map((file) => [file, ['XPOD_INRUPT_OPERATION_CLEANUP']]),
    },
  ];
  for (const check of checks) {
    if (!postinstall.includes(check.script)) continue;
    const directory = path.join(root, 'node_modules', check.name);
    const manifest = path.join(directory, 'package.json');
    if (!existsSync(manifest) || readJson(manifest).version !== '3.1.1') {
      failures.push(`${check.name}: postinstall patch requires installed version 3.1.1 — run: bun install`);
      continue;
    }
    for (const [file, snippets] of check.files) {
      const target = path.join(directory, file);
      const content = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const normalized = content.replace(/\s+/gu, ' ');
      if (snippets.some((snippet) => !normalized.includes(snippet))) {
        failures.push(`${check.name}/${file}: ${check.script} missing or incomplete — run: bun run postinstall`);
      }
    }
  }
  if (postinstall.includes('patch-jose.js')) {
    // Traverse installed package boundaries, not source trees or Bun's cache.
    const queue = [path.join(root, 'node_modules')];
    while (queue.length > 0) {
      const directory = queue.pop()!;
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const packageDir = path.join(directory, entry.name);
        if (entry.name.startsWith('@')) { queue.push(packageDir); continue; }
        const manifest = path.join(packageDir, 'package.json');
        if (!existsSync(manifest)) continue;
        if (entry.name === 'jose' && existsSync(path.join(packageDir, 'dist/node/esm/index.js')) &&
            /"bun"\s*:\s*"\.\/dist\/browser\//u.test(readFileSync(manifest, 'utf8'))) {
          failures.push(`${packageDir}: jose Bun exports are unpatched — run: bun run postinstall`);
        }
        queue.push(path.join(packageDir, 'node_modules'));
      }
    }
  }
}

function workspacePackages(): Array<{ name: string; directory: string }> {
  const packagesDir = path.join(root, 'packages');
  if (!existsSync(packagesDir)) {
    return [];
  }
  return readdirSync(packagesDir)
    .map((entry) => path.join(packagesDir, entry))
    .filter((directory) => existsSync(path.join(directory, 'package.json')))
    .map((directory) => ({ name: readJson(path.join(directory, 'package.json')).name as string, directory }));
}

function exportedFiles(packageJson: any): string[] {
  const collect = (value: unknown): string[] => {
    if (typeof value === 'string') {
      return [value];
    }
    if (!value || typeof value !== 'object') {
      return [];
    }
    return Object.values(value).flatMap(collect);
  };
  return [...collect(packageJson.exports), ...(typeof packageJson.main === 'string' ? [packageJson.main] : [])]
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
}

function missingWorkspaceBuilds(): string[] {
  return workspacePackages()
    .filter(({ directory }) => {
      const packageJson = readJson(path.join(directory, 'package.json'));
      const files = exportedFiles(packageJson);
      return files.length > 0 && files.some((file) => !existsSync(path.join(directory, file)));
    })
    .map(({ name }) => name);
}

function ensureWorkspaceBuilds(): void {
  const missing = missingWorkspaceBuilds();
  if (missing.length === 0) {
    return;
  }
  console.log(`[deps] workspace build output missing for ${missing.join(', ')}; rebuilding packages`);
  try {
    execFileSync('bun', ['run', 'build:packages'], { cwd: root, stdio: 'inherit' });
  } catch {
    failures.push('workspace package build failed — run: bun run build:packages');
    return;
  }
  const stillMissing = missingWorkspaceBuilds();
  if (stillMissing.length > 0) {
    failures.push(`workspace build output still missing for ${stillMissing.join(', ')} — run: bun run build:packages`);
  }
}

const timingEnabled = process.env.XPOD_DEPS_TIMING === '1';
const time = <T>(label: string, run: () => T): T => {
  const startedAt = Date.now();
  const result = run();
  if (timingEnabled) {
    console.error(`[deps-timing] ${label}: ${Date.now() - startedAt}ms`);
  }
  return result;
};

time('patches', () => checkPatchedDependencies());
time('postinstall', () => checkPostinstallPatches());
time('workspace', () => ensureWorkspaceBuilds());

if (failures.length > 0) {
  console.error('\n[deps] dependency state is not usable:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log('[deps] patched dependencies and workspace builds are consistent');
