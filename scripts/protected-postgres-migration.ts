#!/usr/bin/env bun
import { exportProtectedPostgres, restoreProtectedPostgres } from './lib/protected-postgres-migration';

async function main(): Promise<void> {
  const controller=new AbortController();
  process.once('SIGTERM',()=>controller.abort()); process.once('SIGINT',()=>controller.abort());
  const [operation,...args] = process.argv.slice(2);
  const options = new Map<string,string>();
  for (let index=0;index<args.length;index+=2) {
    if (!['--source-env','--target-env','--out','--backup','--manifest-sha256'].includes(args[index]) || !args[index+1] || options.has(args[index])) throw new Error('invalid-arguments');
    options.set(args[index],args[index+1]);
  }
  const required = (flag: string): string => { const value=options.get(flag); if (!value) throw new Error('missing-argument'); return value; };
  const secret = (flag: string): string => { const name=required(flag); if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !process.env[name]) throw new Error('missing-connection-environment'); return process.env[name]!; };
  if (operation==='export') await exportProtectedPostgres({ sourceUrl: secret('--source-env'),outDir: required('--out'),signal:controller.signal });
  else if (operation==='restore') await restoreProtectedPostgres({ targetUrl: secret('--target-env'),backupDir: required('--backup'),outDir: required('--out'),manifestSha256: required('--manifest-sha256'),signal:controller.signal });
  else throw new Error('invalid-operation');
  process.stdout.write(`${JSON.stringify({stage: operation,status:'ok'})}\n`);
}
main().catch(()=>{ process.stderr.write(`${JSON.stringify({stage:'protected-postgres-migration',status:'failed'})}\n`);process.exitCode=1; });
