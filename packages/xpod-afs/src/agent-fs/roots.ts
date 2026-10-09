import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ManagedRoot {
  localPath: string;
  podRoot: string;
}

export interface ManagedTarget {
  root: ManagedRoot;
  /** Pod-root-relative path (POSIX, trailing slash for directories). */
  relFromRoot: string;
  /** cwd-relative-to-Pod-root path (POSIX, trailing slash). */
  relCwd: string;
}

export function normalizePodRoot(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  // A managed root must be a canonical container URL: no query, hash or userinfo.
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return undefined;
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function withTrailingSlash(relative: string): string {
  return relative.length === 0 ? '' : `${relative.replace(/\/+$/, '')}/`;
}

function realpathOrUndefined(value: string): string | undefined {
  try {
    return realpathSync(value);
  } catch {
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function parseManagedRoots(raw: unknown): ManagedRoot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const roots: ManagedRoot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as { localPath?: unknown; podRoot?: unknown };
    if (typeof candidate.localPath !== 'string' || typeof candidate.podRoot !== 'string') {
      continue;
    }
    const podRoot = normalizePodRoot(candidate.podRoot);
    if (!podRoot) {
      continue;
    }
    roots.push({ localPath: path.resolve(candidate.localPath), podRoot });
  }
  // Longest local prefix first so nested roots resolve to the most specific one.
  roots.sort((left, right) => right.localPath.length - left.localPath.length);
  return roots;
}

export function loadManagedRoots(env: NodeJS.ProcessEnv = process.env): ManagedRoot[] {
  const inline = env.XPOD_AGENT_FS_ROOTS;
  if (inline) {
    try {
      return parseManagedRoots(JSON.parse(inline));
    } catch {
      return [];
    }
  }
  const file = env.XPOD_AGENT_FS_ROOTS_FILE;
  if (file) {
    try {
      return parseManagedRoots(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  }
  return [];
}

export function resolveManagedTarget(
  cwd: string,
  pathArg: string | undefined,
  roots: ManagedRoot[],
): ManagedTarget | undefined {
  const absoluteCwd = path.resolve(cwd);
  const absoluteTarget = path.resolve(absoluteCwd, pathArg ?? '.');

  // Trust the real filesystem identity, not string prefixes: a symlink inside
  // the root may point outside it.
  const realCwd = realpathOrUndefined(absoluteCwd);
  const realTarget = realpathOrUndefined(absoluteTarget);
  if (!realCwd || !realTarget) {
    return undefined;
  }

  const root = roots.find((candidate) => {
    const realRoot = realpathOrUndefined(candidate.localPath);
    return realRoot !== undefined && isWithin(realRoot, realCwd);
  });
  if (!root) {
    return undefined;
  }
  const realRoot = realpathOrUndefined(root.localPath);
  if (!realRoot || !isWithin(realRoot, realTarget)) {
    return undefined;
  }

  // Directory targets only in this batch. An explicit file path would become a
  // directory prefix and produce a false zero-hit result, so fall back instead.
  let stats;
  try {
    stats = statSync(realTarget);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory()) {
    return undefined;
  }

  return {
    root,
    relCwd: withTrailingSlash(toPosix(path.relative(realRoot, realCwd))),
    relFromRoot: withTrailingSlash(toPosix(path.relative(realRoot, realTarget))),
  };
}

export function displayPrefixFor(pathArg: string | undefined): string {
  if (pathArg === undefined) {
    return '';
  }
  if (pathArg === '.') {
    return './';
  }
  return pathArg.endsWith('/') ? pathArg : `${pathArg}/`;
}

export function stripPrefix(entryPath: string, prefix: string): string {
  if (!prefix) {
    return entryPath;
  }
  return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : entryPath;
}

export function hasHiddenSegment(relativePath: string): boolean {
  return relativePath
    .split('/')
    .some((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && segment.startsWith('.'));
}
