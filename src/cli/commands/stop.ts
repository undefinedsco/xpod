import type { CommandModule } from 'yargs';

interface StopArgs {
  port: number;
  host: string;
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
      }),
  handler: async (argv) => {
    const baseUrl = `http://${argv.host}:${argv.port}`;
    console.log(`Stopping xpod at ${baseUrl}...`);

    try {
      const res = await fetch(`${baseUrl}/service/status`);
      if (!res.ok) {
        console.error('Service not reachable or already stopped.');
        process.exit(1);
      }

      const statuses = (await res.json()) as Array<{ name: string; status: string; pid?: number }>;
      const running = statuses.filter((s) => s.status === 'running');

      if (running.length === 0) {
        console.log('No running services found.');
        return;
      }

      // Send SIGTERM to the gateway process via the internal stop endpoint
      const stopRes = await fetch(`${baseUrl}/service/stop`, { method: 'POST' });
      if (stopRes.ok) {
        console.log('Stop signal sent.');
      } else {
        // Fallback: print PIDs for manual kill
        console.log('Could not send stop signal via API. Running services:');
        for (const s of running) {
          console.log(`  ${s.name} (pid: ${s.pid ?? 'unknown'})`);
        }
        console.log('\nTo stop manually, kill the gateway process.');
      }
    } catch {
      console.error(`Cannot connect to xpod at ${baseUrl}. Is it running?`);
      process.exit(1);
    }
  },
};
