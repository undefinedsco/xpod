import yargs from 'yargs';
import { MODULE_CATALOG, moduleDefinition } from './module-catalog';
import { ModuleStore } from './module-store';
import { writeJsonResult } from './lib/output';
import { XPOD_CLI_VERSION } from './manifest';

/** Public CLI contains client operations and the module host, never server or AFS code. */
export async function runCli(args: string[], store = new ModuleStore()): Promise<number> {
  const module = moduleDefinition(args[0]);
  if (module) return store.run(module.id, args.slice(1));
  const [auth, login, resources, pod] = await Promise.all([
    import('./commands/auth'), import('./commands/login'), import('./commands/resource'), import('./commands/pod'),
  ]);
  await yargs(args).scriptName('xpod').usage('$0 <command> [options]')
    .command(auth.authCommand).command(login.loginCommandModule).command(pod.podCommand)
    .command(resources.getCommand).command(resources.putCommand).command(resources.patchCommand)
    .command(resources.deleteCommand).command(resources.headCommand).command(resources.listCommand)
    .command('module <operation> [id]', 'Manage optional CSS/API/AFS modules', parser => parser
      .version(false)
      .positional('operation', { choices: ['list', 'install', 'remove'] as const, demandOption: true })
      .positional('id', { type: 'string' }).option('version', { type: 'string', default: 'latest', description: 'Exact module version, or latest on explicit installation' }), async argv => {
      if (argv.operation === 'list') {
        writeJsonResult(await Promise.all(MODULE_CATALOG.map(async definition => ({ id: definition.id, installed: await store.current(definition.id) ?? null }))));
      } else {
        if (!argv.id) throw new Error('Specify a module id: css, api or afs.');
        if (argv.operation === 'install') writeJsonResult(await store.install(argv.id, argv.version));
        else { await store.remove(argv.id); writeJsonResult({ id: argv.id, removed: true }); }
      }
    })
    .epilog('Optional commands: css, api, afs (agent-fs). First use downloads the selected module; installed versions remain pinned until an explicit install.')
    .strict().help().version(XPOD_CLI_VERSION).demandCommand(1).parseAsync(args.length ? args : ['--help']);
  return 0;
}
