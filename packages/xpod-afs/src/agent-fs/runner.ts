import { AgentDirectoryClient } from '../directory/client';
import type { AgentDirectorySearchMatch } from '../directory/protocol';
import type { RgInvocation } from './args';
import {
  displayPrefixFor,
  hasHiddenSegment,
  resolveManagedTarget,
  stripPrefix,
  type ManagedRoot,
} from './roots';

export class ManagedTargetUnresolvedError extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = 'ManagedTargetUnresolvedError';
  }
}

export interface ManagedRunDependencies {
  client: AgentDirectoryClient;
  cwd: string;
  roots: ManagedRoot[];
  stdoutIsTty: boolean;
}

export interface ManagedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Non-zero code used for any incomplete managed scan (partial or not). */
const INCOMPLETE_EXIT_CODE = 2;

export async function runManagedInvocation(
  invocation: RgInvocation,
  deps: ManagedRunDependencies,
): Promise<ManagedRunResult> {
  const target = resolveManagedTarget(deps.cwd, invocation.pathArg, deps.roots);
  if (!target) {
    throw new ManagedTargetUnresolvedError('cwd or path argument is outside the configured managed Pod roots');
  }

  if (invocation.kind === 'files') {
    return runFiles(invocation, target.root.podRoot, target.relFromRoot, deps);
  }
  return runSearch(invocation, target.root.podRoot, target.relFromRoot, deps);
}

async function runFiles(
  invocation: Extract<RgInvocation, { kind: 'files' }>,
  podRoot: string,
  relFromRoot: string,
  deps: ManagedRunDependencies,
): Promise<ManagedRunResult> {
  const listing = await deps.client.listAll({
    root: podRoot,
    ...(relFromRoot ? { pathPrefix: relFromRoot } : {}),
  });

  const prefix = displayPrefixFor(invocation.pathArg);
  const lines: string[] = [];
  for (const entry of listing.entries) {
    if (entry.type !== 'file') {
      continue;
    }
    const relativeToTarget = stripPrefix(entry.path, relFromRoot);
    if (!invocation.hidden && hasHiddenSegment(relativeToTarget)) {
      continue;
    }
    lines.push(`${prefix}${relativeToTarget}`);
  }

  if (!listing.complete) {
    return {
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: 'xpod-rg: warning: directory listing was incomplete\n',
      exitCode: INCOMPLETE_EXIT_CODE,
    };
  }

  return {
    stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    stderr: '',
    exitCode: lines.length > 0 ? 0 : 1,
  };
}

async function runSearch(
  invocation: Extract<RgInvocation, { kind: 'search' }>,
  podRoot: string,
  relFromRoot: string,
  deps: ManagedRunDependencies,
): Promise<ManagedRunResult> {
  const response = await deps.client.searchAll({
    root: podRoot,
    query: invocation.query,
    ignoreCase: invocation.ignoreCase,
    ...(relFromRoot ? { pathPrefix: relFromRoot } : {}),
  });

  const prefix = displayPrefixFor(invocation.pathArg);
  const lineNumber = invocation.lineNumber ?? false;

  const visibleMatches = response.matches.filter((match) => {
    const relativeToTarget = stripPrefix(match.path, relFromRoot);
    return invocation.hidden || !hasHiddenSegment(relativeToTarget);
  });

  // ripgrep's default output prints one line per matching line and -c counts
  // matching lines, not occurrences; collapse duplicates by (path, line).
  const uniqueMatches = dedupeMatches(visibleMatches, relFromRoot);

  const lines: string[] = [];
  if (invocation.filesWithMatches) {
    const seen = new Set<string>();
    for (const match of uniqueMatches) {
      const relativeToTarget = stripPrefix(match.path, relFromRoot);
      if (seen.has(relativeToTarget)) {
        continue;
      }
      seen.add(relativeToTarget);
      lines.push(`${prefix}${relativeToTarget}`);
    }
  } else if (invocation.count) {
    const counts = new Map<string, { display: string; count: number }>();
    for (const match of uniqueMatches) {
      const relativeToTarget = stripPrefix(match.path, relFromRoot);
      const entry = counts.get(relativeToTarget) ?? { display: `${prefix}${relativeToTarget}`, count: 0 };
      entry.count += 1;
      counts.set(relativeToTarget, entry);
    }
    for (const entry of [ ...counts.values() ].sort((left, right) => (left.display < right.display ? -1 : 1))) {
      lines.push(`${entry.display}:${entry.count}`);
    }
  } else {
    for (const match of sortMatches(uniqueMatches, relFromRoot)) {
      const relativeToTarget = stripPrefix(match.path, relFromRoot);
      const location = lineNumber ? `${match.line}:` : '';
      lines.push(`${prefix}${relativeToTarget}:${location}${match.text}`);
    }
  }

  const hasMatches = uniqueMatches.length > 0;
  const complete = response.complete && !response.hasUnscannedScope;

  if (!complete) {
    // Partial results must never be presented as a successful full scan, even
    // when some matches were found. Emit the partial output but fail.
    return {
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: 'xpod-rg: warning: search scope was not fully scanned\n',
      exitCode: INCOMPLETE_EXIT_CODE,
    };
  }

  return {
    stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    stderr: '',
    exitCode: hasMatches ? 0 : 1,
  };
}

function dedupeMatches(matches: AgentDirectorySearchMatch[], relFromRoot: string): AgentDirectorySearchMatch[] {
  const seen = new Set<string>();
  const result: AgentDirectorySearchMatch[] = [];
  for (const match of matches) {
    const key = `${stripPrefix(match.path, relFromRoot)}\u0000${match.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(match);
  }
  return result;
}

function sortMatches(matches: AgentDirectorySearchMatch[], relFromRoot: string): AgentDirectorySearchMatch[] {
  return [ ...matches ].sort((left, right) => {
    const leftPath = stripPrefix(left.path, relFromRoot);
    const rightPath = stripPrefix(right.path, relFromRoot);
    if (leftPath !== rightPath) {
      return leftPath < rightPath ? -1 : 1;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.column - right.column;
  });
}
