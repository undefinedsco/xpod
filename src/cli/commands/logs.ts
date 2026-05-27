import type { CommandModule } from 'yargs';
import { CliCommandError, handleCliError, writeJsonResult } from '../lib/output';

interface LogsArgs {
  port: number;
  host: string;
  service?: string;
  level?: string;
  limit: number;
  env?: string;
  json: boolean;
}

export const logsCommand: CommandModule<object, LogsArgs> = {
  command: 'logs',
  describe: 'View service logs',
  builder: (yargs) =>
    yargs
      .option('port', {
        alias: 'p',
        type: 'number',
        description: 'Gateway port',
        default: 3000,
      })
      .option('host', {
        type: 'string',
        description: 'Gateway host',
        default: 'localhost',
      })
      .option('env', {
        alias: 'e',
        type: 'string',
        description: 'Env file path for runtime context',
      })
      .option('service', {
        alias: 's',
        type: 'string',
        description: 'Filter by service name (css, api)',
      })
      .option('level', {
        alias: 'l',
        type: 'string',
        choices: ['info', 'warn', 'error'],
        description: 'Filter by log level',
      })
      .option('limit', {
        alias: 'n',
        type: 'number',
        description: 'Number of log lines to show',
        default: 50,
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Output JSON envelope',
      }),
  handler: async (argv) => {
    const baseUrl = `http://${argv.host}:${argv.port}`;
    const params = new URLSearchParams();
    if (argv.service) params.set('source', argv.service);
    if (argv.level) params.set('level', argv.level);
    params.set('limit', String(argv.limit));

    try {
      const res = await fetch(`${baseUrl}/service/logs?${params}`);
      if (!res.ok) {
        throw new CliCommandError('server_logs_failed', `Failed to get logs: HTTP ${res.status}`, 1, {
          status: res.status,
        });
      }

      const logs = (await res.json()) as Array<{
        timestamp: string;
        level: string;
        source: string;
        message: string;
      }>;

      if (argv.json) {
        writeJsonResult({ logs });
        return;
      }

      if (logs.length === 0) {
        console.log('No logs found.');
        return;
      }

      for (const entry of logs) {
        const ts = new Date(entry.timestamp).toLocaleTimeString();
        const level = entry.level.toUpperCase().padEnd(5);
        console.log(`${ts} [${level}] [${entry.source}] ${entry.message}`);
      }
    } catch (error) {
      handleCliError(error instanceof Error ? error : new Error(`Cannot connect to xpod at ${baseUrl}. Is it running?`), argv.json);
    }
  },
};
