import os from 'node:os';
import path from 'node:path';

export function defaultXpodEnvPath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
} = {}): string {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Xpod', '.env');
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Xpod', '.env');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'xpod', '.env');
}

export function resolveXpodEnvPath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(explicitPath || env.XPOD_ENV_FILE || defaultXpodEnvPath({ env }));
}
