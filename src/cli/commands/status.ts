import type { CommandModule } from 'yargs';

interface StatusArgs {
  port: number;
  host: string;
  json: boolean;
}

export const statusCommand: CommandModule<object, StatusArgs> = {
  command: 'status',
  describe: 'Show service status',
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
      .option('json', {
        type: 'boolean',
        description: 'Output as JSON',
        default: false,
      }),
  handler: async (argv) => {
    const baseUrl = `http://${argv.host}:${argv.port}`;

    try {
      const res = await fetch(`${baseUrl}/service/status`);
      if (!res.ok) {
        console.error(`Failed to get status: HTTP ${res.status}`);
        process.exit(1);
      }

      const statuses = (await res.json()) as Array<{
        name: string;
        status: string;
        pid?: number;
        uptime?: number;
        restartCount: number;
        lastExitCode?: number;
      }>;

      if (argv.json) {
        console.log(JSON.stringify(statuses, null, 2));
        return;
      }

      if (statuses.length === 0) {
        console.log('No services registered.');
        return;
      }

      const statusIcon = (s: string): string => {
        switch (s) {
          case 'running': return '●';
          case 'stopped': return '○';
          case 'starting': return '◌';
          case 'crashed': return '✗';
          default: return '?';
        }
      };

      for (const svc of statuses) {
        const icon = statusIcon(svc.status);
        const uptime = svc.uptime != null ? ` uptime=${formatUptime(svc.uptime)}` : '';
        const pid = svc.pid != null ? ` pid=${svc.pid}` : '';
        const restarts = svc.restartCount > 0 ? ` restarts=${svc.restartCount}` : '';
        console.log(`${icon} ${svc.name.padEnd(8)} ${svc.status}${pid}${uptime}${restarts}`);
      }
    } catch {
      console.error(`Cannot connect to xpod at ${baseUrl}. Is it running?`);
      process.exit(1);
    }
  },
};

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
