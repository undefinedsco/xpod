import yargs from 'yargs';
import { writeSync } from 'node:fs';
import { MODULE_CATALOG, moduleDefinition } from './module-catalog';
import { ModuleStore } from './module-store';
import { writeJsonResult } from './lib/output';
import { XPOD_CLI_VERSION } from './manifest';
import { startCommand } from './commands/start';

/**
 * The ONE canonical store context for this process.
 *
 * A packaged desktop starts the CLI as a child process and hands it exactly three
 * values: the OWNED writable module root, the READ-ONLY seed inside the app bundle,
 * and the offline flag. They are read here, at instance creation, and passed as
 * explicit options — there is no process-wide snapshot and no second source of
 * truth. A half-specified packaged context (seed without root, or the reverse) is
 * rejected rather than silently degrading to `$HOME` or to the registry.
 */
export function moduleStoreContext(env: NodeJS.ProcessEnv = process.env): {
  root?: string; seed?: string; offline?: boolean;
} {
  const root = env.XPOD_MODULES_ROOT;
  const seed = env.XPOD_MODULES_SEED;
  const offline = env.XPOD_MODULES_OFFLINE === '1';
  if (root === undefined && seed === undefined && !offline) return {};
  if (!root || !seed) {
    throw new Error('Packaged module context requires both XPOD_MODULES_ROOT and XPOD_MODULES_SEED');
  }
  if (!offline) {
    throw new Error('Packaged module context requires XPOD_MODULES_OFFLINE=1');
  }
  return { root, seed, offline: true };
}

/** Public CLI contains client operations and the module host, never server or AFS code. */
export async function runCli(args: string[], store = new ModuleStore(moduleStoreContext())): Promise<number> {
  const module = moduleDefinition(args[0]);
  if (module) return store.run(module.id, args.slice(1));
  const [auth, login, resources, pod] = await Promise.all([
    import('./commands/auth'), import('./commands/login'), import('./commands/resource'), import('./commands/pod'),
  ]);
  await yargs(args).scriptName('xpod').usage('$0 <command> [options]')
    .command(startCommand(store))
    .command(auth.authCommand).command(login.loginCommandModule).command(pod.podCommand)
    .command(resources.getCommand).command(resources.putCommand).command(resources.patchCommand)
    .command(resources.deleteCommand).command(resources.headCommand).command(resources.listCommand)
    .command('module <operation> [id]', 'Manage optional CSS/API/AFS modules', parser => parser
      .version(false)
      .positional('operation', { choices: ['list', 'install', 'remove'] as const, demandOption: true })
      .positional('id', { type: 'string' }).option('diagnostics', { type: 'boolean', default: false, description: 'Write bounded module install phase timings to stderr' }).option('version', { type: 'string', default: 'latest', description: 'Exact module version, or latest on explicit installation' }), async argv => {
      if (argv.operation === 'list') {
        writeJsonResult(await Promise.all(MODULE_CATALOG.map(async definition => ({ id: definition.id, installed: await store.current(definition.id) ?? null }))));
      } else {
        if (!argv.id) throw new Error('Specify a module id: css, api or afs.');
        if (argv.operation === 'install') writeJsonResult(await store.install(argv.id, argv.version, argv.diagnostics ? event => { writeSync(2, JSON.stringify(event) + '\n'); } : undefined));
        else { await store.remove(argv.id); writeJsonResult({ id: argv.id, removed: true }); }
      }
    })
    .epilog('Optional commands: css, api, afs (agent-fs). First use downloads the selected module; installed versions remain pinned until an explicit install.')
    .strict().help().version(XPOD_CLI_VERSION).demandCommand(1).parseAsync(args.length ? args : ['--help']);
  return 0;
}
