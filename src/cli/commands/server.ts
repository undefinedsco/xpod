import type { CommandModule } from 'yargs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { startCommand } from './start';
import { stopCommand } from './stop';
import { statusCommand } from './status';
import { logsCommand } from './logs';
import { handleCliError, writeJsonResult } from '../lib/output';

interface ServerArgs {
  json?: boolean;
}

interface HealthArgs extends ServerArgs {
  port: number;
  host: string;
  env?: string;
}

interface ConfigArgs extends ServerArgs {
  key?: string;
  value?: string;
}

function configPath(): string {
  return join(homedir(), '.xpod', 'server-config.json');
}

function readConfig(): Record<string, string> {
  try {
    const path = configPath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).map(([ key, value ]) => [ key, String(value) ]))
      : {};
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, string>): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

const healthCommand: CommandModule<object, HealthArgs> = {
  command: 'health',
  describe: 'Show xpod server health checks',
  builder: (yargs) =>
    yargs
      .option('port', { alias: 'p', type: 'number', default: 3000, description: 'Gateway port' })
      .option('host', { type: 'string', default: 'localhost', description: 'Gateway host' })
      .option('env', { alias: 'e', type: 'string', description: 'Env file path for runtime context' })
      .option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: async (argv) => {
    const baseUrl = `http://${argv.host}:${argv.port}`;
    try {
      const checks: Record<string, 'pass' | 'fail'> = {
        gateway: 'fail',
        css: 'fail',
        api: 'fail',
      };

      try {
        const gateway = await fetch(`${baseUrl}/service/status`);
        checks.gateway = gateway.ok ? 'pass' : 'fail';
      } catch {
        checks.gateway = 'fail';
      }

      try {
        const css = await fetch(`${baseUrl}/`, { method: 'HEAD' });
        checks.css = css.ok ? 'pass' : 'fail';
      } catch {
        checks.css = 'fail';
      }

      try {
        const api = await fetch(`${baseUrl}/api/ready`);
        checks.api = api.ok ? 'pass' : 'fail';
      } catch {
        checks.api = 'fail';
      }

      const data = {
        schemaVersion: '1.0',
        healthy: Object.values(checks).every((status) => status === 'pass'),
        checks,
        timestamp: new Date().toISOString(),
      };

      if (argv.json) {
        writeJsonResult(data);
        return;
      }
      console.log(data.healthy ? 'Healthy' : 'Unhealthy');
      for (const [ name, status ] of Object.entries(checks)) {
        console.log(`  ${name}: ${status}`);
      }
    } catch (error) {
      handleCliError(error, argv.json === true);
    }
  },
};

const configGetCommand: CommandModule<object, ConfigArgs> = {
  command: 'get <key>',
  describe: 'Get xpod server config value',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', demandOption: true, description: 'Config key' })
      .option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: (argv) => {
    const config = readConfig();
    const value = config[argv.key!];
    if (argv.json) {
      writeJsonResult({ key: argv.key, value: value ?? null });
      return;
    }
    if (value === undefined) {
      console.log('');
      return;
    }
    console.log(value);
  },
};

const configSetCommand: CommandModule<object, ConfigArgs> = {
  command: 'set <key> <value>',
  describe: 'Set xpod server config value',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', demandOption: true, description: 'Config key' })
      .positional('value', { type: 'string', demandOption: true, description: 'Config value' })
      .option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: (argv) => {
    const config = readConfig();
    config[argv.key!] = argv.value!;
    writeConfig(config);
    const data = { key: argv.key, value: argv.value, path: configPath() };
    if (argv.json) {
      writeJsonResult(data);
      return;
    }
    console.log(`${argv.key}=${argv.value}`);
  },
};

const configListCommand: CommandModule<object, ConfigArgs> = {
  command: 'list',
  describe: 'List xpod server config values',
  builder: (yargs) => yargs.option('json', { type: 'boolean', default: false, description: 'Output JSON envelope' }),
  handler: (argv) => {
    const config = readConfig();
    if (argv.json) {
      writeJsonResult({ config, path: configPath() });
      return;
    }
    for (const [ key, value ] of Object.entries(config)) {
      console.log(`${key}=${value}`);
    }
  },
};

export const serverConfigCommand: CommandModule<object, ConfigArgs> = {
  command: 'config',
  describe: 'Manage xpod server config',
  builder: (yargs) =>
    yargs
      .command(configGetCommand)
      .command(configSetCommand)
      .command(configListCommand)
      .demandCommand(1, 'Please specify a server config subcommand'),
  handler: () => {},
};

export const serverCommand: CommandModule<object, ServerArgs> = {
  command: 'server',
  describe: 'Manage the xpod server runtime',
  builder: (yargs) =>
    yargs
      .command(startCommand)
      .command(stopCommand)
      .command(statusCommand)
      .command(healthCommand)
      .command(logsCommand)
      .command(serverConfigCommand)
      .demandCommand(1, 'Please specify a server subcommand'),
  handler: () => {},
};
