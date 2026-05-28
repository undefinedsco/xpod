import type { CommandModule } from 'yargs';
import { CliCommandError, handleCliError, writeJsonResult } from '../lib/output';

interface StatusArgs {
  port: number;
  host: string;
  json: boolean;
  env?: string;
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
      .option('env', {
        alias: 'e',
        type: 'string',
        description: 'Env file path for runtime context',
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
        throw new CliCommandError('server_status_failed', `Failed to get status: HTTP ${res.status}`, 1, {
          status: res.status,
        });
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
        const running = statuses.some((svc) => svc.status === 'running');
        const ready = statuses.length > 0 && statuses.every((svc) => svc.status === 'running');
        writeJsonResult({
          schemaVersion: '1.0',
          running,
          ready,
          baseUrl: `${baseUrl}/`,
          port: argv.port,
          services: statuses,
        });
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
    } catch (error) {
      handleCliError(error instanceof Error ? error : new Error(`Cannot connect to xpod at ${baseUrl}. Is it running?`), argv.json);
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
