import fs from 'node:fs';
import path from 'node:path';

/** Bind a packaged CSS deployment to its own native runtime. ModuleStore owns
 * complete inventory/hash admission; this adapter only selects that input. */
export function bindPackagedCssNativeRuntime(packageRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND?.trim()) return;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
    xpodModule?: { id?: string; files?: Array<{ path?: string }> };
  };
  if (manifest.xpodModule?.id !== 'css') return;
  const relative = 'native/qlever/bin/xpod_qlever_local_runtime';
  if (!manifest.xpodModule.files?.some(file => file.path === relative)) {
    throw new Error('Packaged CSS native runtime is not declared');
  }
  const command = path.join(packageRoot, relative);
  const stat = fs.lstatSync(command);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Packaged CSS native runtime is not regular');
  const realRoot = fs.realpathSync(packageRoot);
  const realCommand = fs.realpathSync(command);
  const within = path.relative(realRoot, realCommand);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('Packaged CSS native runtime is outside its package');
  }
  env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = realCommand;
}
