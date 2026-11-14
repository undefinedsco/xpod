import { openPrivateEvidence } from './private-evidence';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveRuntimeLaunchCommand } from '../src/runtime-manager';

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
type Probe = (command: string, args: string[], env: NodeJS.ProcessEnv) => string;
const probe: Probe = (command, args, env) => execFileSync(command, args, { env, encoding: 'utf8', timeout: 30000 });
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/** Run only after signing. Evidence is external: never rewrite sealed .app resources. */
export function verifySignedRuntime(app: string, evidence: string, home: string, run: Probe = probe): void {
  const appRoot = realpathSync(app);
  const evidenceFile = path.resolve(realpathSync(path.dirname(evidence)), path.basename(evidence));
  if (inside(appRoot, evidenceFile) || existsSync(evidenceFile)) throw new Error('Evidence must be a new file outside the signed app');
  const isolatedHome = realpathSync(home);
  if (inside(appRoot, isolatedHome) || !lstatSync(isolatedHome).isDirectory() || (lstatSync(isolatedHome).mode & 0o077) !== 0 || readdirSync(isolatedHome).length !== 0) throw new Error('Use a private isolated HOME outside the app');
  const resourcesPath = path.join(appRoot, 'Contents/Resources');
  const launch = resolveRuntimeLaunchCommand({ env: {}, resourcesPath, packaged: true, resolveBunCommand: () => { throw new Error('System runtime fallback forbidden'); } });
  if (!launch) throw new Error('Signed app has no complete bundled CLI/Bun');
  const bun = realpathSync(launch.command), cli = realpathSync(launch.args[0]);
  if (!inside(appRoot, bun) || !inside(appRoot, cli)) throw new Error('Runtime resolved outside app');
  const authorityFile = path.join(resourcesPath, 'runtime/licenses/bun/receipt.json');
  const authorityBytes = readFileSync(authorityFile);
  const authority = JSON.parse(authorityBytes.toString());
  const pin = JSON.parse(readFileSync(fileURLToPath(new URL('../../packages/xpod-cli/licenses/javascript/generated/1.4.2/index.json', import.meta.url)), 'utf8'));
  const expected = pin.provenance;
  if (authority.runtimePhase !== 'pre-sign' || typeof authority.executableSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(authority.executableSha256) || authority.executableSha256 !== expected.compiler.executableSha256
    || authority.target !== expected.compiler.platform || authority.version !== pin.bunVersion
    || authority.sourceCommit !== expected.bunCommit || authority.revision !== expected.revision
    || authority.archiveSha256 !== expected.compiler.officialArchiveSha256) throw new Error('Invalid pre-sign runtime authority identity');
  const env = { HOME: isolatedHome, PATH: '', TMPDIR: isolatedHome };
  const output = openPrivateEvidence(path.dirname(evidenceFile), path.basename(evidenceFile));
  try {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appRoot], env);
  const finalBunHash = digest(bun), finalCliHash = digest(cli);
  const revision = run(bun, ['--revision'], env).trim();
  if (revision !== authority.revision) throw new Error('Signed runtime revision mismatch');
  const sqlite = run(bun, ['-e', "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');if(d.prepare('select 1 as ok').get().ok!==1)throw Error('SQLite failed');d.close();console.log('sqlite-ok');"], env).trim();
  if (sqlite !== 'sqlite-ok') throw new Error('Signed runtime SQLite probe failed');
  run(bun, [cli, '--help'], env);
  const moduleList = run(bun, [cli, 'module', 'list'], env);
  const listed = JSON.parse(moduleList);
  if (listed.ok !== true || !Array.isArray(listed.data)) throw new Error('Invalid normal CLI module list');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appRoot], env);
  if (digest(bun) !== finalBunHash || digest(cli) !== finalCliHash) throw new Error('Signed runtime changed during probes');
  output.write(JSON.stringify({ appPath: appRoot, scope: 'signed app runtime and normal CLI probes; not full application launch',
    preSignAuthoritySha256: createHash('sha256').update(authorityBytes).digest('hex'),
    officialArchiveExecutableSha256: authority.executableSha256,
    finalSignedExecutableSha256: finalBunHash, finalCliSha256: finalCliHash, revision,
    emptyPath: true, runtimeSelection: 'RuntimeManager canonical packaged resolver',
    sqlitePassed: true, cliHelpPassed: true, cliModuleListPassed: true, signatureVerified: true,
    runtimeManagerProcessLaunchVerified: false, actualDesktopWindowVerified: false,
  }, null, 2));
  } finally { output.close(); }
}

if (import.meta.main) {
  if (process.argv.length !== 5) throw new Error('Usage: verify-signed-runtime.ts <app> <external-evidence.json> <private-empty-home>');
  verifySignedRuntime(...process.argv.slice(2) as [string, string, string]);
}
