#!/usr/bin/env bun
/**
 * Standalone Xpod CLI entry (preview packaging).
 *
 * This is a thin client-only entry that reuses the existing auth and agent-fs
 * command registrations from `src/cli/commands/*`. It deliberately does NOT
 * register the control-server commands (start/stop/status/logs/server/account/
 * backup/restore/doctor) and does not import the Xpod server runtime, UI or
 * Agent SDK.
 */
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export const XPOD_CLI_VERSION = '0.1.0-preview.1';

/** Commands exposed by the standalone client. Control-server commands are absent. */
const CLIENT_COMMANDS = new Set([ 'auth', 'login', 'agent-fs' ]);
const PSEUDO = new Set([ 'help', 'version', '--help', '-h', '--version', '-v' ]);

/**
 * Bun compiled binaries expose `process.argv = [ "bun", "/$bunfs/root/<bin>", ...userArgs ]`.
 * Existing helper code (see `src/cli/agent-fs/mount.ts`) re-invokes the CLI as
 * `<execPath> <resolved argv[1]> agent-fs proxy ...`, and the wrapper launcher
 * does the same. Normalize by dropping a single leading non-command path so the
 * compiled binary behaves like the source entry for nested invocations.
 */
function normalizedArgs(): string[] {
  const raw = process.argv.slice(2);
  if (raw.length > 0 && !CLIENT_COMMANDS.has(raw[0]) && !PSEUDO.has(raw[0]) && looksLikePath(raw[0])) {
    return raw.slice(1);
  }
  return raw;
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.startsWith('.') || value.endsWith('.js') || value.endsWith('.ts');
}

export async function createClientParser() {
  const [ { authCommand }, { loginCommandModule }, { agentFsCommand } ] = await Promise.all([
    import('../../../src/cli/commands/auth'),
    import('../../../src/cli/commands/login'),
    import('../../../src/cli/commands/agent-fs'),
  ]);

  return yargs()
    .scriptName('xpodcli')
    .usage('Xpod CLI - standalone Pod client (auth + agent filesystem)')
    .command(authCommand)
    .command(loginCommandModule)
    .command(agentFsCommand)
    .demandCommand(1, 'Please specify a command')
    .strict()
    .help()
    .version(XPOD_CLI_VERSION);
}

export async function main(argv: string[] = normalizedArgs()): Promise<void> {
  if (argv[0] === 'agent-fs' && argv[1] === 'rg') {
    const { runRgWrapperMain } = await import('../../../src/cli/agent-fs/rg-entry');
    await runRgWrapperMain(argv.slice(2));
    return;
  }

  const wantsHelp = argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h';
  const wantsVersion = argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version';

  const parser = await createClientParser();
  if (wantsVersion) {
    parser.parse([ '--version' ]);
    return;
  }
  parser.parse(wantsHelp ? [ '--help' ] : argv);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
