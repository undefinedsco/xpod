import type { CommandModule } from 'yargs';

interface LogsArgs {
  port: number;
  host: string;
  service?: string;
  level?: string;
  limit: number;
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
        console.error(`Failed to get logs: HTTP ${res.status}`);
        process.exit(1);
      }

      const logs = (await res.json()) as Array<{
        timestamp: string;
        level: string;
        source: string;
        message: string;
      }>;

      if (logs.length === 0) {
        console.log('No logs found.');
        return;
      }

      for (const entry of logs) {
        const ts = new Date(entry.timestamp).toLocaleTimeString();
        const level = entry.level.toUpperCase().padEnd(5);
        console.log(`${ts} [${level}] [${entry.source}] ${entry.message}`);
      }
    } catch {
      console.error(`Cannot connect to xpod at ${baseUrl}. Is it running?`);
      process.exit(1);
    }
  },
};
