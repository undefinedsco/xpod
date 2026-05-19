#!/usr/bin/env node
import '../runtime/configure-drizzle-solid';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Known subcommands
const KNOWN_COMMANDS = [
  'start', 'stop', 'status', 'logs',
  'auth', 'login', 'config', 'import', 'pod',
  'account', 'backup', 'restore', 'doctor',
];

function createRootParser() {
  return yargs(hideBin(process.argv))
    .scriptName('xpod')
    .usage('$0 <command> [options]')
    .epilog(`Commands: ${KNOWN_COMMANDS.join(', ')}`)
    .help()
    .version();
}

async function createCommandParser() {
  const [
    { startCommand },
    { stopCommand },
    { statusCommand },
    { logsCommand },
    { authCommand },
    { loginCommandModule },
    { configCommand },
    { importCommand },
    { podCommand },
    { accountCommand },
    { backupCommand, restoreCommand },
    { doctorCommand },
  ] = await Promise.all([
    import('./commands/start'),
    import('./commands/stop'),
    import('./commands/status'),
    import('./commands/logs'),
    import('./commands/auth'),
    import('./commands/login'),
    import('./commands/config'),
    import('./commands/import'),
    import('./commands/pod'),
    import('./commands/account'),
    import('./commands/backup'),
    import('./commands/doctor'),
  ]);

  return createRootParser()
    .command(startCommand)
    .command(stopCommand)
    .command(statusCommand)
    .command(logsCommand)
    .command(authCommand)
    .command(loginCommandModule)
    .command(configCommand)
    .command(importCommand)
    .command(podCommand)
    .command(accountCommand)
    .command(backupCommand)
    .command(restoreCommand)
    .command(doctorCommand)
    .strict()
    .help()
    .version();
}

async function main() {
  const argv = process.argv.slice(2);
  const wantsRootHelp = argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
  const wantsVersion = argv.includes('--version') || argv.includes('-v');

  if (wantsRootHelp || wantsVersion) {
    createRootParser().parse();
    return;
  }

  (await createCommandParser())
    .demandCommand(1, 'Please specify an operations command')
    .parse();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
