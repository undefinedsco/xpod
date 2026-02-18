#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { logsCommand } from './commands/logs';
import { authCommand } from './commands/auth';
import { configCommand } from './commands/config';

yargs(hideBin(process.argv))
  .scriptName('xpod')
  .usage('$0 <command> [options]')
  .command(startCommand)
  .command(stopCommand)
  .command(statusCommand)
  .command(logsCommand)
  .command(authCommand)
  .command(configCommand)
  .demandCommand(1, 'Please specify a command')
  .strict()
  .help()
  .parse();
