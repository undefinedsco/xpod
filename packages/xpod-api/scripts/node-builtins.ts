import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { satisfies } from 'semver';

export interface NodeBuiltinAuthority {
  version: string;
  execPath: string;
  binarySHA256: string;
  requestSHA256: string;
  results: Array<{ specifier: string; builtin: boolean }>;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const request = (specifiers: string[]) => [...new Set(specifiers)].sort();

export function verifyNodeBuiltinAuthority(authority: NodeBuiltinAuthority, specifiers: string[], supportedRange: string): void {
  const ids = request(specifiers);
  if (!authority || !satisfies(authority.version, supportedRange) || authority.requestSHA256 !== hash(JSON.stringify(ids))
    || !/^[a-f0-9]{64}$/u.test(authority.binarySHA256) || realpathSync(authority.execPath) !== authority.execPath
    || hash(readFileSync(authority.execPath)) !== authority.binarySHA256 || !Array.isArray(authority.results)
    || authority.results.length !== ids.length || authority.results.some((row, index) => row.specifier !== ids[index] || typeof row.builtin !== 'boolean')) {
    throw new Error('Node builtin build authority drift');
  }
}

/** Node is used only as an explicit compatibility build checker, never a service fallback. */
export function nodeBuiltinAuthority(specifiers: string[], supportedRange: string): NodeBuiltinAuthority {
  const ids = request(specifiers);
  if (ids.length > 10000 || ids.some(id => !id || Buffer.byteLength(id) > 4096)) throw new Error('Builtin request bound exceeded');
  const result = spawnSync('node', ['--input-type=commonjs', '-e', `
const fs=require('node:fs'),crypto=require('node:crypto'),mod=require('node:module');
if(process.versions.bun)throw Error('Actual Node build checker required');
const ids=JSON.parse(fs.readFileSync(0,'utf8'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const execPath=fs.realpathSync(process.execPath);
console.log(JSON.stringify({version:process.version,execPath,binarySHA256:hash(fs.readFileSync(execPath)),requestSHA256:hash(JSON.stringify(ids)),results:ids.map(specifier=>({specifier,builtin:mod.isBuiltin(specifier)}))}));
`], { input: JSON.stringify(ids), encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  if (result.error || result.status !== 0) throw new Error('Portable API build requires a working supported Node checker: ' + (result.error?.message ?? result.stderr));
  const authority = JSON.parse(result.stdout) as NodeBuiltinAuthority;
  verifyNodeBuiltinAuthority(authority, ids, supportedRange);
  return authority;
}
