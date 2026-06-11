#!/usr/bin/env node
import '../runtime/configure-drizzle-solid';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Known subcommands
const KNOWN_COMMANDS = [
  'get', 'put', 'patch', 'delete', 'head', 'list',
  'rdf', 'obj', 'schema', 'secret', 'server', 'start', 'stop', 'status', 'logs',
  'auth', 'login', 'import', 'pod',
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
    { serverCommand },
    { getCommand, putCommand, patchCommand, deleteCommand, headCommand, listCommand },
    { rdfCommand },
    { objCommand },
    { schemaCommand },
    { secretCommand },
    { authCommand },
    { loginCommandModule },
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
    import('./commands/server'),
    import('./commands/resource'),
    import('./commands/rdf'),
    import('./commands/obj'),
    import('./commands/schema'),
    import('./commands/secret'),
    import('./commands/auth'),
    import('./commands/login'),
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
    .command(serverCommand)
    .command(getCommand)
    .command(putCommand)
    .command(patchCommand)
    .command(deleteCommand)
    .command(headCommand)
    .command(listCommand)
    .command(rdfCommand)
    .command(objCommand)
    .command(schemaCommand)
    .command(secretCommand)
    .command(authCommand)
    .command(loginCommandModule)
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
  const wantsRootHelp = argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h';
  const wantsVersion = argv[0] === '--version' || argv[0] === '-v';

  if (wantsRootHelp || wantsVersion) {
    const parser = wantsRootHelp ? await createCommandParser() : createRootParser();
    parser.parse(wantsVersion ? [ '--version' ] : [ '--help' ]);
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
