import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs/promises';
import path from 'path';

export interface GatewayConfig {
  port: number;
  host: string;
  baseUrl?: string;
  css: {
    enabled: boolean;
    config?: string; // Path to CSS config file (e.g. config/main.local.json)
    port?: number;   // Forced internal port
  };
  api: {
    enabled: boolean;
    port?: number;   // Forced internal port
  };
}

export async function loadConfig(): Promise<GatewayConfig> {
  const argv = await yargs(hideBin(process.argv))
    .option('config', { alias: 'c', type: 'string', description: 'Path to config file' })
    .option('port', { alias: 'p', type: 'number', description: 'Gateway port' })
    .option('host', { alias: 'h', type: 'string', description: 'Gateway host' })
    .help()
    .parse();

  // Read from environment variables first
  // CSS_PORT is the gateway's listening port (external facing)
  // Internal CSS and API ports are auto-discovered
  const envPort = process.env.CSS_PORT ? parseInt(process.env.CSS_PORT, 10) : undefined;
  const envHost = process.env.CSS_HOST;

  const defaultConfig: GatewayConfig = {
    port: envPort ?? 3000,
    host: envHost ?? 'localhost',
    css: { enabled: true },
    api: { enabled: true },
  };

  let fileConfig: Partial<GatewayConfig> = {};
  if (argv.config) {
    try {
      const configPath = path.resolve(process.cwd(), argv.config);
      const content = await fs.readFile(configPath, 'utf-8');
      fileConfig = JSON.parse(content);
      console.log(`[Gateway] Loaded config from ${configPath}`);
    } catch (e) {
      console.warn(`[Gateway] Failed to load config from ${argv.config}:`, e);
      process.exit(1);
    }
  }

  // Merge strategy
  return {
    ...defaultConfig,
    ...fileConfig,
    port: argv.port ?? fileConfig.port ?? defaultConfig.port,
    host: argv.host ?? fileConfig.host ?? defaultConfig.host,
    css: { ...defaultConfig.css, ...fileConfig.css },
    api: { ...defaultConfig.api, ...fileConfig.api },
  };
}
