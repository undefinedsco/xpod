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

export const XPOD_CLI_VERSION = '0.1.0-preview.1';

/** Client commands; server/control commands are not registered here. */
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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
