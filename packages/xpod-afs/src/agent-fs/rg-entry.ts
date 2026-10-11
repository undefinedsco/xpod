import { AgentDirectoryClient } from '../directory/client';
import { authFetch, requireAuthContext } from '@undefineds.co/xpod-cli/client';
import { parseRgArgs } from './args';
import { resolveNativeBinary, execNativeBinary } from './native';
import { loadManagedRoots, resolveManagedTarget } from './roots';
import { ManagedTargetUnresolvedError, runManagedInvocation } from './runner';
import { defaultSessionDir, observeSession } from './session-view';

function writeError(message: string): void {
  process.stderr.write(`xpod-rg: ${message}\n`);
}

/**
 * Entry point used by the generated `rg` wrapper script. It either serves the
 * invocation from the Pod HTTP directory backend or execs the pre-resolved
 * native ripgrep binary with the original argv.
 */
export async function runRgWrapperMain(argv: string[]): Promise<void> {
  const wrapperDir = process.env.XPOD_AGENT_FS_WRAPPER_DIR;
  const nativeRg = resolveNativeBinary('rg', process.env, wrapperDir ? [ wrapperDir ] : []);
  if (!nativeRg) {
    writeError('could not resolve the native rg binary; set XPOD_AGENT_FS_NATIVE_RG');
    process.exitCode = 2;
    return;
  }

  const fallbackToNative = async (): Promise<void> => {
    try {
      process.exitCode = await execNativeBinary(nativeRg, argv, process.cwd());
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  };

  const parsed = parseRgArgs(argv);
  if (parsed.kind === 'fallback') {
    await fallbackToNative();
    return;
  }
  const invocation = parsed.invocation;

  if (
    process.stdout.isTTY &&
    invocation.kind === 'search' &&
    (invocation.lineNumber === undefined || !invocation.noHeading || invocation.color !== 'never')
  ) {
    // Interactive ripgrep adds line numbers/headings/color by default; only an
    // explicit non-interactive-equivalent invocation can be reproduced.
    await fallbackToNative();
    return;
  }
  // ripgrep reads stdin when no path is given; the managed backend cannot.
  if (invocation.kind === 'search' && invocation.pathArg === undefined && process.stdin?.isTTY !== true) {
    await fallbackToNative();
    return;
  }

  const roots = loadManagedRoots();
  if (roots.length === 0) {
    await fallbackToNative();
    return;
  }
  const target = resolveManagedTarget(process.cwd(), invocation.pathArg, roots);
  if (!target) {
    await fallbackToNative();
    return;
  }

  // A remote index cannot represent unpublished edits. Use the native tool on
  // the actual merged mount whenever this session has a delta. Do not maintain
  // a separate TypeScript overlay or silently search stale remote content.
  let sessionBefore: ReturnType<typeof observeSession>;
  try {
    sessionBefore = observeSession(defaultSessionDir());
    if (sessionBefore.podRoot === target.root.podRoot && sessionBefore.pending > 0) {
      await fallbackToNative();
      return;
    }
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  // Production uses the CLI's single authenticated request entry point
  // (`authFetch`) so any token type/refresh handled there is preserved. The
  // access-token override exists only for isolated wrapper tests.
  let client: AgentDirectoryClient;
  const tokenOverride = process.env.XPOD_AGENT_FS_ACCESS_TOKEN;
  if (tokenOverride) {
    client = new AgentDirectoryClient({ baseUrl: target.root.podRoot, accessToken: tokenOverride });
  } else {
    try {
      const context = await requireAuthContext({});
      client = new AgentDirectoryClient({
        baseUrl: target.root.podRoot,
        request: (url, init) => authFetch(context, url, init),
      });
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
  }

  try {
    const result = await runManagedInvocation(invocation, {
      client,
      cwd: process.cwd(),
      roots,
      stdoutIsTty: process.stdout.isTTY === true,
    });
    const sessionAfter = observeSession(defaultSessionDir());
    if (sessionAfter.podRoot === target.root.podRoot && sessionAfter.version !== sessionBefore.version) {
      await fallbackToNative();
      return;
    }
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof ManagedTargetUnresolvedError) {
      await fallbackToNative();
      return;
    }
    writeError(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
