import type { CommandModule } from 'yargs';
import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { resolve } from 'path';

interface DoctorArgs {
  url?: string;
}

interface CheckResult {
  ok: boolean;
  label: string;
}

function check(ok: boolean, label: string): CheckResult {
  const icon = ok ? '✓' : '✗';
  console.log(`${icon} ${label}`);
  return { ok, label };
}

async function checkNodeVersion(): Promise<CheckResult> {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  return check(major >= 18, `Node.js v${process.versions.node} (≥ 18)`);
}

async function checkServerReachable(url?: string): Promise<CheckResult> {
  if (!url) return check(true, 'Server check skipped (no --url)');
  const base = url.endsWith('/') ? url : `${url}/`;
  try {
    const res = await fetch(`${base}.account/`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    return check(res.ok, `Server reachable at ${base}`);
  } catch {
    return check(false, `Server unreachable at ${base}`);
  }
}

function checkFileExists(filePath: string, label: string): CheckResult {
  return check(existsSync(resolve(filePath)), label);
}

function checkBuildFreshness(): CheckResult {
  const distPath = resolve('dist');
  const srcPath = resolve('src');
  if (!existsSync(distPath)) {
    return check(false, 'dist/ exists');
  }
  try {
    const distStat = statSync(distPath);
    const srcStat = statSync(srcPath);
    const fresh = distStat.mtimeMs >= srcStat.mtimeMs;
    return check(fresh, fresh ? 'dist/ up to date' : 'dist/ outdated (run yarn build)');
  } catch {
    return check(true, 'dist/ exists');
  }
}

function checkPortAvailable(port: number): CheckResult {
  try {
    const output = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (output) {
      return check(false, `Port ${port} in use (PID: ${output.split('\n')[0]})`);
    }
    return check(true, `Port ${port} available`);
  } catch {
    // lsof returns non-zero when no process found — port is free
    return check(true, `Port ${port} available`);
  }
}

export const doctorCommand: CommandModule<object, DoctorArgs> = {
  command: 'doctor',
  describe: 'Check environment and diagnose issues',
  builder: (yargs) =>
    yargs
      .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Server URL to check connectivity',
      }),
  handler: async (argv) => {
    console.log('Running diagnostics...\n');

    const results: CheckResult[] = [];

    results.push(await checkNodeVersion());
    results.push(checkPortAvailable(3000));
    results.push(await checkServerReachable(argv.url));
    results.push(checkFileExists('.env.local', '.env.local found'));
    results.push(checkFileExists('.env.server', '.env.server found'));
    results.push(checkFileExists('config/local.json', 'config/local.json found'));
    results.push(checkFileExists('config/cloud.json', 'config/cloud.json found'));
    results.push(checkFileExists('node_modules', 'node_modules/ exists'));
    results.push(checkBuildFreshness());

    const failed = results.filter((r) => !r.ok);
    console.log('');
    if (failed.length === 0) {
      console.log('All checks passed.');
    } else {
      console.log(`${failed.length} issue(s) found.`);
    }
  },
};
