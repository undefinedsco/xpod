import type { CommandModule } from 'yargs';
import { CliCommandError, fail, handleCliError, writeJson, writeJsonResult } from '../lib/output';

interface StopArgs {
  port: number;
  host: string;
  env?: string;
  timeout: number;
  json: boolean;
}

export const stopCommand: CommandModule<object, StopArgs> = {
  command: 'stop',
  describe: 'Stop xpod services',
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
      .option('timeout', {
        type: 'number',
        default: 10000,
        description: 'Graceful stop timeout in milliseconds',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        description: 'Output JSON envelope',
      }),
  handler: async (argv) => {
    const baseUrl = `http://${argv.host}:${argv.port}`;
    if (!argv.json) {
      console.log(`Stopping xpod at ${baseUrl}...`);
    }

    try {
      const res = await fetch(`${baseUrl}/service/status`);
      if (!res.ok) {
        throw new CliCommandError('server_not_reachable', 'Service not reachable or already stopped.', 1, {
          status: res.status,
        });
      }

      const statuses = (await res.json()) as Array<{ name: string; status: string; pid?: number }>;
      const running = statuses.filter((s) => s.status === 'running');

      if (running.length === 0) {
        if (argv.json) {
          writeJsonResult({ running: false, stopped: false, services: statuses }, 'not_running');
          return;
        }
        console.log('No running services found.');
        return;
      }

      // Send SIGTERM to the gateway process via the internal stop endpoint
      const stopRes = await fetch(`${baseUrl}/service/stop`, { method: 'POST' });
      if (stopRes.ok) {
        if (argv.json) {
          writeJsonResult({ running: true, stopped: true, services: running });
          return;
        }
        console.log('Stop signal sent.');
      } else {
        if (argv.json) {
          writeJson(fail('stop_signal_failed', 'Could not send stop signal via API.', [], {
            running: true,
            stopped: false,
            services: running,
          }));
          return;
        }
        // Fallback: print PIDs for manual kill
        console.log('Could not send stop signal via API. Running services:');
        for (const s of running) {
          console.log(`  ${s.name} (pid: ${s.pid ?? 'unknown'})`);
        }
        console.log('\nTo stop manually, kill the gateway process.');
      }
    } catch (error) {
      handleCliError(error instanceof Error ? error : new Error(`Cannot connect to xpod at ${baseUrl}. Is it running?`), argv.json);
    }
  },
};
