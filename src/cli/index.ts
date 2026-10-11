#!/usr/bin/env node
import { ensureSupportedBun } from '../runtime/compat/ensureSupportedBun';
import '../runtime/configure-drizzle-solid';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { CommandModule } from 'yargs';

// Command declarations own both help names and lazy host registration.
// Builders own each command's argument types; the heterogeneous host registry
// erases only that type parameter, after each module has been typechecked.
const commandLoaders: Array<{ names: string[]; load(): Promise<Array<CommandModule<object, any>>> }> = [
  { names: ['start'], load: async () => { const module = await import('./commands/start'); return [module.startCommand]; } },
  { names: ['stop'], load: async () => { const module = await import('./commands/stop'); return [module.stopCommand]; } },
  { names: ['status'], load: async () => { const module = await import('./commands/status'); return [module.statusCommand]; } },
  { names: ['logs'], load: async () => { const module = await import('./commands/logs'); return [module.logsCommand]; } },
  { names: ['server'], load: async () => { const module = await import('./commands/server'); return [module.serverCommand]; } },
  { names: ['get', 'put', 'patch', 'delete', 'head', 'list'], load: async () => { const module = await import('./commands/resource'); return [module.getCommand, module.putCommand, module.patchCommand, module.deleteCommand, module.headCommand, module.listCommand]; } },
  { names: ['rdf'], load: async () => { const module = await import('./commands/rdf'); return [module.rdfCommand]; } },
  { names: ['obj'], load: async () => { const module = await import('./commands/obj'); return [module.objCommand]; } },
  { names: ['secret'], load: async () => { const module = await import('./commands/secret'); return [module.secretCommand]; } },
  { names: ['auth'], load: async () => { const module = await import('./commands/auth'); return [module.authCommand]; } },
  { names: ['login'], load: async () => { const module = await import('./commands/login'); return [module.loginCommandModule]; } },
  { names: ['import'], load: async () => { const module = await import('./commands/import'); return [module.importCommand]; } },
  { names: ['pod'], load: async () => { const module = await import('./commands/pod'); return [module.podCommand]; } },
  { names: ['account'], load: async () => { const module = await import('./commands/account'); return [module.accountCommand]; } },
  { names: ['backup', 'restore'], load: async () => { const module = await import('./commands/backup'); return [module.backupCommand, module.restoreCommand]; } },
  { names: ['doctor'], load: async () => { const module = await import('./commands/doctor'); return [module.doctorCommand]; } },
  { names: ['agent-fs'], load: async () => { const module = await import('./commands/agent-fs'); return [module.agentFsCommand]; } },
 ];
const KNOWN_COMMANDS = commandLoaders.flatMap((loader) => loader.names);

function createRootParser() {
  return yargs(hideBin(process.argv)).scriptName('xpod').usage('$0 <command> [options]')
    .epilog(`Commands: ${KNOWN_COMMANDS.join(', ')}`).help().version();
}

async function createCommandParser(requestedCommand?: string) {
  let parser = createRootParser();
  // Flags before the command retain the complete legacy parser.
  const selected = KNOWN_COMMANDS.includes(requestedCommand ?? '')
    ? commandLoaders.filter((loader) => loader.names.includes(requestedCommand!)) : commandLoaders;
  for (const loader of selected) {
    for (const command of await loader.load()) parser = parser.command(command);
  }
  return parser.strict().help().version();
}

async function main() {
  ensureSupportedBun();
  const argv = process.argv.slice(2);
  if (argv[0] === 'agent-fs' && argv[1] === 'rg') {
    const { runRgWrapperMain } = await import('./agent-fs/rg-entry');
    await runRgWrapperMain(argv.slice(2));
    return;
  }
  if (argv[0] === 'start' || argv[0]?.startsWith('__internal-')) {
    await import('../runtime/service-entry');
    return;
  }
  const wantsRootHelp = argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h';
  const wantsVersion = argv[0] === '--version' || argv[0] === '-v';

  if (wantsRootHelp || wantsVersion) {
    const parser = wantsRootHelp ? await createCommandParser() : createRootParser();
    parser.parse(wantsVersion ? [ '--version' ] : [ '--help' ]);
    return;
  }

  (await createCommandParser(argv[0]))
    .demandCommand(1, 'Please specify an operations command')
    .parse();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
