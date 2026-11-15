import yargs from 'yargs';
import { agentFsCommand } from './commands';
import { runRgWrapperMain } from './agent-fs/rg-entry';

export async function runAfs(args: string[]): Promise<void> {
  if (args[0] === 'rg') { await runRgWrapperMain(args.slice(1)); return; }
  const parser = yargs(args).scriptName('xpod afs').strict().exitProcess(false);
  (agentFsCommand.builder as (parser: ReturnType<typeof yargs>) => unknown)(parser);
  await parser.parseAsync();
}
