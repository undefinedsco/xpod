import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  AgentDirectoryClient,
  type ListParams,
  type SearchParams,
} from '../../src/agent-directory/client/AgentDirectoryClient';
import type {
  AgentDirectoryListResponse,
  AgentDirectorySearchMatch,
  AgentDirectorySearchResponse,
} from '../../src/agent-directory/protocol';
import { parseRgArgs } from '../../src/cli/agent-fs/args';
import { runManagedInvocation, type ManagedRunResult } from '../../src/cli/agent-fs/runner';
import {
  parseManagedRoots,
  resolveManagedTarget,
  type ManagedRoot,
} from '../../src/cli/agent-fs/roots';
import { execNativeBinary, resolveNativeBinary } from '../../src/cli/agent-fs/native';
import { installRgWrapper, renderEnvExports, shellQuote } from '../../src/cli/agent-fs/install';

const REPO_ROOT = process.cwd();
const RG = process.env.XPOD_TEST_RG ?? 'rg';
const BUN = process.env.XPOD_BUN ?? 'bun';
const POD_ROOT = 'https://pod.example/alice/';

const FIXTURE_PARENT = path.join(REPO_ROOT, '.test-data', 'agent-directory-workers', 'rg-differential');
const ROOT = path.join(FIXTURE_PARENT, 'root');
const OUTSIDE = path.join(FIXTURE_PARENT, 'outside');
const NATIVE_DIR = path.join(FIXTURE_PARENT, 'path-native');
const WRAPPER_DIR = path.join(FIXTURE_PARENT, 'path-wrapper');
const NATIVE_LINK = path.join(FIXTURE_PARENT, 'native-link');

const ROOTS: ManagedRoot[] = [ { localPath: ROOT, podRoot: POD_ROOT } ];
const BASE = [ '--no-ignore', '--sort', 'path', '--no-heading', '--color', 'never' ];

function writeFixtureFile(absolute: string, content: string): void {
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function writeExecutable(file: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(file, body, 'utf8');
  chmodSync(file, 0o755);
}

function buildFixture(): void {
  writeFixtureFile(path.join(ROOT, 'alpha.txt'), 'alpha needle one\nsecond line\n');
  writeFixtureFile(path.join(ROOT, 'no_match.txt'), 'nothing to see here\n');
  writeFixtureFile(path.join(ROOT, 'dup.txt'), 'needle needle same line\n');
  writeFixtureFile(path.join(ROOT, 'empty.txt'), '');
  writeFixtureFile(path.join(ROOT, 'unicode.txt'), 'unicode café needle Ω\n');
  writeFixtureFile(path.join(ROOT, 'sub dir', 'gamma.txt'), 'needle gamma in sub\n');
  writeFixtureFile(path.join(ROOT, 'sub dir', 'nested', 'delta.txt'), 'deep needle nested\n');
  writeFixtureFile(path.join(ROOT, '.hidden', 'secret.txt'), 'needle hidden secret\n');
  writeFixtureFile(path.join(OUTSIDE, 'external.txt'), 'outside needle\n');

  mkdirSync(NATIVE_DIR, { recursive: true });
  writeExecutable(path.join(NATIVE_DIR, 'rg'));
  mkdirSync(WRAPPER_DIR, { recursive: true });
  writeExecutable(path.join(WRAPPER_DIR, 'rg'));

  symlinkSync(OUTSIDE, path.join(ROOT, 'link-out'));
  rmSync(NATIVE_LINK, { force: true });
  symlinkSync(path.join(WRAPPER_DIR, 'rg'), NATIVE_LINK);
}

function listFixtureFiles(dir: string, prefix = ''): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const absolute = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      entries.push(...listFixtureFiles(absolute, relative));
    } else if (stat.isFile()) {
      entries.push(relative);
    }
  }
  return entries;
}

function searchResponse(overrides: Partial<AgentDirectorySearchResponse> = {}): AgentDirectorySearchResponse {
  return {
    root: POD_ROOT,
    query: 'needle',
    mode: 'literal',
    ignoreCase: false,
    matches: [],
    truncated: false,
    complete: true,
    scannedFiles: 0,
    skippedUnauthorized: 0,
    skippedUnsupported: 0,
    hasUnscannedScope: false,
    ...overrides,
  };
}

function listResponse(overrides: Partial<AgentDirectoryListResponse> = {}): AgentDirectoryListResponse {
  return {
    root: POD_ROOT,
    entries: [],
    truncated: false,
    complete: true,
    scanned: 0,
    skippedUnauthorized: 0,
    ...overrides,
  };
}

function match(file: string, line: number, text: string): AgentDirectorySearchMatch {
  return { path: file, url: `${POD_ROOT}${file}`, line, column: 1, text, matched: 'needle' };
}

class FixtureAgentDirectoryClient extends AgentDirectoryClient {
  private readonly rootDir: string;
  private readonly allFiles: string[];

  public constructor(rootDir: string) {
    super({ baseUrl: POD_ROOT, accessToken: 'acceptance-token' });
    this.rootDir = rootDir;
    this.allFiles = [ ...listFixtureFiles(rootDir) ].sort();
  }

  public override async list(params: ListParams): Promise<AgentDirectoryListResponse> {
    const prefix = params.pathPrefix ?? '';
    const files = this.allFiles.filter((file) => file.startsWith(prefix));
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const limit = params.limit ?? files.length;
    const slice = files.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < files.length;
    return {
      root: params.root,
      entries: slice.map((file) => ({ path: file, url: `${params.root}${file}`, type: 'file' as const })),
      truncated: hasMore,
      complete: !hasMore,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
      scanned: slice.length,
      skippedUnauthorized: 0,
    };
  }

  public override async search(params: SearchParams): Promise<AgentDirectorySearchResponse> {
    const prefix = params.pathPrefix ?? '';
    const files = this.allFiles.filter((file) => file.startsWith(prefix));
    const matches: AgentDirectorySearchMatch[] = [];
    for (const file of files) {
      const content = readFileSync(path.join(this.rootDir, file), 'utf8');
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (index === lines.length - 1 && line === '' && content.endsWith('\n')) {
          continue;
        }
        if (params.query.length === 0) {
          continue;
        }
        let from = 0;
        while (true) {
          const position = line.indexOf(params.query, from);
          if (position === -1) {
            break;
          }
          matches.push({
            path: file,
            url: `${params.root}${file}`,
            line: index + 1,
            column: position + 1,
            text: line,
            matched: params.query,
          });
          from = position + Math.max(1, params.query.length);
        }
      }
    }
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const limit = params.limit ?? matches.length;
    const slice = matches.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < matches.length;
    return {
      root: params.root,
      query: params.query,
      mode: 'literal',
      ignoreCase: Boolean(params.ignoreCase),
      matches: slice,
      truncated: hasMore,
      complete: !hasMore,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
      scannedFiles: files.length,
      skippedUnauthorized: 0,
      skippedUnsupported: 0,
      hasUnscannedScope: false,
    };
  }
}

class CannedAgentDirectoryClient extends AgentDirectoryClient {
  private readonly searchPages: AgentDirectorySearchResponse[];
  private readonly listPages: AgentDirectoryListResponse[];

  public constructor(searchPages: AgentDirectorySearchResponse[] = [], listPages: AgentDirectoryListResponse[] = []) {
    super({ baseUrl: POD_ROOT, accessToken: 'acceptance-token' });
    this.searchPages = [ ...searchPages ];
    this.listPages = [ ...listPages ];
  }

  public override async search(): Promise<AgentDirectorySearchResponse> {
    const page = this.searchPages.shift();
    if (!page) {
      throw new Error('no canned search page left');
    }
    return page;
  }

  public override async list(): Promise<AgentDirectoryListResponse> {
    const page = this.listPages.shift();
    if (!page) {
      throw new Error('no canned list page left');
    }
    return page;
  }
}

async function runManaged(args: string[], cwd: string): Promise<ManagedRunResult> {
  const parsed = parseRgArgs(args);
  if (parsed.kind !== 'managed') {
    throw new Error(`expected a managed invocation but classifier fell back: ${parsed.reason}`);
  }
  return runManagedInvocation(parsed.invocation, {
    client: new FixtureAgentDirectoryClient(ROOT),
    cwd,
    roots: ROOTS,
    stdoutIsTty: false,
  });
}

function runSystemRg(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(RG, args, { cwd, encoding: 'utf8' });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 };
}

beforeAll(() => {
  const probe = spawnSync(RG, [ '--version' ], { encoding: 'utf8' });
  if (probe.status !== 0) {
    throw new Error(`real ripgrep binary "${RG}" is required as the differential oracle: ${probe.stderr ?? ''}`);
  }
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  buildFixture();
});

afterAll(() => {
  rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

describe('rg wrapper differential vs system ripgrep (same fixture)', () => {
  const differentialCases: Array<{ name: string; args: string[]; cwd: string }> = [
    { name: '--files implicitly scoped to cwd', args: [ '--files', ...BASE ], cwd: ROOT },
    { name: '--files with explicit dot prefix', args: [ '--files', ...BASE, '.' ], cwd: ROOT },
    { name: '--files with an explicit subdirectory containing a space', args: [ '--files', ...BASE, 'sub dir' ], cwd: ROOT },
    { name: '--files including hidden entries', args: [ '--files', '--hidden', ...BASE ], cwd: ROOT },
    { name: 'fixed-string search with explicit dot (no line numbers)', args: [ '-F', 'needle', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string search with line numbers and explicit dot', args: [ '-F', '-n', 'needle', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string search in cwd subdirectory with line numbers', args: [ '-F', '-n', 'needle', ...BASE, '.' ], cwd: path.join(ROOT, 'sub dir') },
    { name: 'fixed-string search under a subdirectory argument with a space', args: [ '-F', '-n', 'needle', ...BASE, 'sub dir' ], cwd: ROOT },
    { name: 'fixed-string search listing files with matches (-l)', args: [ '-F', '-l', 'needle', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string search counting matching lines (-c)', args: [ '-F', '-c', 'needle', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string search including hidden entries', args: [ '-F', '--hidden', 'needle', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string search with no matches', args: [ '-F', 'zzz-not-present', ...BASE, '.' ], cwd: ROOT },
    { name: 'fixed-string UTF-8 search', args: [ '-F', 'café', ...BASE, '.' ], cwd: ROOT },
  ];

  for (const testCase of differentialCases) {
    it(testCase.name, async () => {
      const expected = runSystemRg(testCase.args, testCase.cwd);
      const actual = await runManaged(testCase.args, testCase.cwd);

      expect(actual.stdout).toBe(expected.stdout);
      expect(actual.stderr).toBe(expected.stderr);
      expect(actual.exitCode).toBe(expected.status);
    });
  }

  it('emits one line per matching line and counts matching lines, not occurrences', async () => {
    const expected = runSystemRg([ '-F', '-n', 'needle', ...BASE, '.' ], ROOT);
    const actual = await runManaged([ '-F', '-n', 'needle', ...BASE, '.' ], ROOT);

    expect(expected.stdout.split('\n').filter((line) => line.includes('dup.txt'))).toHaveLength(1);
    expect(actual.stdout).toBe(expected.stdout);
  });

  it('--files over an empty directory exits like ripgrep', async () => {
    const emptyRoot = path.join(FIXTURE_PARENT, 'empty-root');
    mkdirSync(emptyRoot, { recursive: true });
    const expected = runSystemRg([ '--files', ...BASE ], emptyRoot);
    const parsed = parseRgArgs([ '--files', ...BASE ]);
    expect(parsed.kind).toBe('managed');
    if (parsed.kind !== 'managed') {
      return;
    }
    const actual = await runManagedInvocation(parsed.invocation, {
      client: new FixtureAgentDirectoryClient(emptyRoot),
      cwd: emptyRoot,
      roots: [ { localPath: emptyRoot, podRoot: POD_ROOT } ],
      stdoutIsTty: false,
    });
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.exitCode).toBe(expected.status);
  });
});

describe('rg wrapper delegates stdin-sensitive invocations to the native binary', () => {
  it('execs the native rg for a no-path search when stdin is not a TTY', () => {
    const marker = path.join(FIXTURE_PARENT, 'native-marker.sh');
    writeExecutable(marker, '#!/bin/sh\nprintf "NATIVE_RG_FALLBACK\\n"\n');
    const env = {
      ...process.env,
      XPOD_AGENT_FS_WRAPPER_DIR: WRAPPER_DIR,
      XPOD_AGENT_FS_NATIVE_RG: marker,
      XPOD_AGENT_FS_ROOTS: JSON.stringify(ROOTS),
      XPOD_AGENT_FS_ACCESS_TOKEN: 'acceptance-token',
    };
    const result = spawnSync(
      BUN,
      [ path.join(REPO_ROOT, 'src/cli/index.ts'), 'agent-fs', 'rg', '-F', 'needle', '--no-ignore', '--sort', 'path' ],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
    expect(result.stdout).toContain('NATIVE_RG_FALLBACK');
  });
});

describe('argv classifier fallback for combinations the backend cannot reproduce', () => {
  const fallbackCases: Array<{ name: string; args: string[] }> = [
    { name: 'regex pattern without -F', args: [ '--no-ignore', '--sort', 'path', '--no-heading', '--color', 'never', 'nee.*' ] },
    { name: 'unknown long option', args: [ '--frobnicate' ] },
    { name: 'unknown short option', args: [ '-z' ] },
    { name: 'empty pattern provided via -e', args: [ '-F', '-e', '', ...BASE, '.' ] },
    { name: 'pattern containing a newline', args: [ '-F', '-e', 'a\nb', ...BASE, '.' ] },
    { name: 'boolean long option with an inline value', args: [ '-F', '--hidden=true', 'needle', ...BASE, '.' ] },
    { name: 'multiple search paths', args: [ '-F', 'needle', ...BASE, 'a', 'b' ] },
    { name: '-l combined with -c', args: [ '-F', '-l', '-c', 'needle', ...BASE, '.' ] },
    { name: '--files combined with a pattern', args: [ 'needle', '--files', ...BASE ] },
    { name: 'ignore-case (-i) unless differential-proven', args: [ '-F', '-i', 'needle', ...BASE, '.' ] },
    { name: '--color=always', args: [ '-F', 'needle', '--no-ignore', '--sort', 'path', '--no-heading', '--color', 'always', '.' ] },
    { name: '--heading output is not reproduced even when non-TTY', args: [ '--heading', '-F', 'needle', '--no-ignore', '--sort', 'path', '--color', 'never', '.' ] },
    { name: 'multiple --regexp patterns', args: [ '-F', '-e', 'needle', '-e', 'gamma', ...BASE, '.' ] },
    { name: 'missing --no-ignore', args: [ '-F', 'needle', '--sort', 'path', '--no-heading', '--color', 'never', '.' ] },
    { name: 'missing --sort path', args: [ '-F', 'needle', '--no-ignore', '--no-heading', '--color', 'never', '.' ] },
  ];

  for (const testCase of fallbackCases) {
    it(`falls back: ${testCase.name}`, () => {
      const parsed = parseRgArgs(testCase.args);
      expect(parsed.kind).toBe('fallback');
    });
  }

  const managedCases: Array<{ name: string; args: string[] }> = [
    { name: '--files', args: [ '--files', ...BASE ] },
    { name: 'fixed-string search', args: [ '-F', 'needle', ...BASE, '.' ] },
    { name: 'line-numbered search', args: [ '-F', '-n', 'needle', ...BASE, '.' ] },
    { name: 'files-with-matches search', args: [ '-F', '-l', 'needle', ...BASE, '.' ] },
    { name: 'count search', args: [ '-F', '-c', 'needle', ...BASE, '.' ] },
    { name: 'search without the optional --no-heading gate', args: [ '-F', 'needle', '--no-ignore', '--sort', 'path', '--color', 'never', '.' ] },
    { name: 'search without the optional --color=never gate', args: [ '-F', 'needle', '--no-ignore', '--sort', 'path', '--no-heading', '.' ] },
  ];

  for (const testCase of managedCases) {
    it(`takes over: ${testCase.name}`, () => {
      const parsed = parseRgArgs(testCase.args);
      expect(parsed.kind).toBe('managed');
    });
  }
});

describe('managed root resolution follows the fixed design', () => {
  it('rejects an explicit file path argument so the native binary handles it', () => {
    expect(resolveManagedTarget(ROOT, 'alpha.txt', ROOTS)).toBeUndefined();
  });

  it('rejects a symlink whose real path escapes the managed root', () => {
    expect(resolveManagedTarget(ROOT, 'link-out', ROOTS)).toBeUndefined();
  });

  it('resolves a directory subpath to a Pod-root-relative directory prefix', () => {
    const target = resolveManagedTarget(ROOT, 'sub dir', ROOTS);
    expect(target?.relFromRoot).toBe('sub dir/');
    expect(target?.relCwd).toBe('');
  });

  it('falls back when cwd is outside every managed root', () => {
    expect(resolveManagedTarget(OUTSIDE, undefined, ROOTS)).toBeUndefined();
  });

  it('rejects path traversal outside the root', () => {
    expect(resolveManagedTarget(ROOT, '../outside', ROOTS)).toBeUndefined();
  });
});

describe('parseManagedRoots canonical URL handling', () => {
  it('rejects pod root URLs carrying query, hash or userinfo', () => {
    const roots = parseManagedRoots([
      { localPath: ROOT, podRoot: 'https://pod.example/alice/?token=1' },
      { localPath: ROOT, podRoot: 'https://pod.example/alice/#fragment' },
      { localPath: ROOT, podRoot: 'https://user:pass@pod.example/alice/' },
    ]);
    expect(roots).toEqual([]);
  });

  it('normalizes a plain container URL to a trailing slash', () => {
    const roots = parseManagedRoots([ { localPath: ROOT, podRoot: 'https://pod.example/alice' } ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].podRoot).toBe('https://pod.example/alice/');
  });

  it('rejects non-http(s) roots', () => {
    expect(parseManagedRoots([ { localPath: ROOT, podRoot: 'ftp://pod.example/alice/' } ])).toEqual([]);
  });
});

describe('native rg resolution cannot recurse into the wrapper', () => {
  it('skips the wrapper directory when scanning PATH', () => {
    const env = { PATH: WRAPPER_DIR, XPOD_AGENT_FS_WRAPPER_DIR: WRAPPER_DIR };
    expect(resolveNativeBinary('rg', env, [ WRAPPER_DIR ])).toBeUndefined();
  });

  it('finds a native rg outside the skipped wrapper directory', () => {
    const env = { PATH: NATIVE_DIR, XPOD_AGENT_FS_WRAPPER_DIR: WRAPPER_DIR };
    expect(resolveNativeBinary('rg', env, [ WRAPPER_DIR ])).toBe(path.join(NATIVE_DIR, 'rg'));
  });

  it('accepts an explicit override outside the wrapper directory', () => {
    const env = { PATH: '', XPOD_AGENT_FS_NATIVE_RG: path.join(NATIVE_DIR, 'rg'), XPOD_AGENT_FS_WRAPPER_DIR: WRAPPER_DIR };
    expect(resolveNativeBinary('rg', env, [])).toBe(path.join(NATIVE_DIR, 'rg'));
  });

  it('rejects an explicit override that resolves back into the wrapper directory', () => {
    const env = { PATH: '', XPOD_AGENT_FS_NATIVE_RG: NATIVE_LINK, XPOD_AGENT_FS_WRAPPER_DIR: WRAPPER_DIR };
    expect(resolveNativeBinary('rg', env, [])).toBeUndefined();
  });

  it('propagates a signal death as 128+signal instead of a plain 1', async () => {
    const code = await execNativeBinary('/bin/sh', [ '-c', 'kill -TERM $$' ], REPO_ROOT);
    expect(code).toBe(143);
  });
});

describe('wrapper installation and env quoting', () => {
  it('shellQuote escapes embedded single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('renderEnvExports round-trips a path with spaces and single quotes through sh', () => {
    const dir = path.join(FIXTURE_PARENT, "install dir's");
    mkdirSync(dir, { recursive: true });
    const exports = renderEnvExports({
      dir,
      wrapperPath: path.join(dir, 'rg'),
      nativeRg: path.join(NATIVE_DIR, 'rg'),
      launcher: [],
    });
    const script = `${exports.join('\n')}\nprintf '%s' "$XPOD_AGENT_FS_WRAPPER_DIR"`;
    const result = spawnSync('/bin/sh', [ '-c', script ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(dir);
  });

  it('writes a syntactically valid wrapper for a path with spaces and single quotes', () => {
    const dir = path.join(FIXTURE_PARENT, "wrapper dir's");
    const result = installRgWrapper({
      dir,
      roots: ROOTS,
      nativeRg: path.join(NATIVE_DIR, 'rg'),
      launcher: [ '/bin/echo' ],
    });
    const syntax = spawnSync('/bin/sh', [ '-n', result.wrapperPath ], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    const script = readFileSync(result.wrapperPath, 'utf8');
    expect(script).toContain(shellQuote(JSON.stringify(ROOTS)));
  });

  it('agent-fs env emits exports that survive eval for a directory containing a single quote', () => {
    const dir = path.join(FIXTURE_PARENT, "cli env's dir");
    mkdirSync(dir, { recursive: true });
    const result = spawnSync(
      BUN,
      [ 'src/cli/index.ts', 'agent-fs', 'env', '--dir', dir, '--native-rg', path.join(NATIVE_DIR, 'rg') ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const exportLines = (result.stdout ?? '').split('\n').filter((line) => line.startsWith('export '));
    expect(exportLines.length).toBeGreaterThan(0);
    const evalResult = spawnSync(
      '/bin/sh',
      [ '-c', `${exportLines.join('\n')}\nprintf '%s' "$XPOD_AGENT_FS_WRAPPER_DIR"` ],
      { encoding: 'utf8' },
    );
    expect(evalResult.status).toBe(0);
    expect(evalResult.stdout).toBe(dir);
  });
});

describe('incomplete scans must not masquerade as complete results', () => {
  const searchInvocation = {
    kind: 'search' as const,
    query: 'needle',
    hidden: false,
    sort: 'path' as const,
    ignoreCase: false,
    filesWithMatches: false,
    count: false,
    noHeading: true,
    color: 'never' as const,
    pathArg: '.',
  };

  it('exits non-zero when a search is incomplete even though matches were returned', async () => {
    const client = new CannedAgentDirectoryClient([
      searchResponse({
        matches: [ match('alpha.txt', 1, 'alpha needle one') ],
        complete: false,
        hasUnscannedScope: true,
      }),
    ]);
    const result = await runManagedInvocation(searchInvocation, {
      client,
      cwd: ROOT,
      roots: ROOTS,
      stdoutIsTty: false,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('exits non-zero for an incomplete scan with zero hits', async () => {
    const client = new CannedAgentDirectoryClient([
      searchResponse({ matches: [], complete: false, hasUnscannedScope: true }),
    ]);
    const result = await runManagedInvocation(searchInvocation, {
      client,
      cwd: ROOT,
      roots: ROOTS,
      stdoutIsTty: false,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('accumulates incompleteness across searched pages', async () => {
    const client = new CannedAgentDirectoryClient([
      searchResponse({
        matches: [ match('alpha.txt', 1, 'alpha needle one') ],
        complete: false,
        hasUnscannedScope: true,
        nextCursor: '1',
      }),
      searchResponse({
        matches: [ match('dup.txt', 1, 'needle needle same line') ],
        complete: true,
        hasUnscannedScope: false,
      }),
    ]);
    const result = await client.searchAll({ root: POD_ROOT, query: 'needle' });
    expect(result.complete).toBe(false);
    expect(result.hasUnscannedScope).toBe(true);
  });

  it('accumulates incompleteness across listed pages', async () => {
    const client = new CannedAgentDirectoryClient([], [
      listResponse({
        entries: [ { path: 'alpha.txt', url: `${POD_ROOT}alpha.txt`, type: 'file' } ],
        complete: false,
        nextCursor: '1',
      }),
      listResponse({
        entries: [ { path: 'dup.txt', url: `${POD_ROOT}dup.txt`, type: 'file' } ],
        complete: true,
      }),
    ]);
    const result = await client.listAll({ root: POD_ROOT });
    expect(result.complete).toBe(false);
  });
});
