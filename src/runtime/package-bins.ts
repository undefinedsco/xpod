import fs from 'node:fs';
import path from 'node:path';
import {jsEntrypointArgs} from './js-runtime';
/** Resolve normal package commands using the current service's JS runtime. */
export function packageBinArgv(root:string,name:string):string[] {
 if(!/^[a-zA-Z0-9._-]+$/u.test(name)||name==='.'||name==='..')throw new Error('Invalid package command name');
 const launcher=path.join(root,'node_modules/.bin',name+'.cjs');
 if(fs.existsSync(launcher))return [process.execPath,...jsEntrypointArgs(launcher,typeof (globalThis as {Bun?:unknown}).Bun!=='undefined')];
 const local=path.join(root,'node_modules/.bin',name);
 if(!fs.existsSync(local))return [name];
 const resolved=fs.realpathSync(local);
 return /\.[cm]?js$/u.test(resolved)?[process.execPath,...jsEntrypointArgs(local,typeof (globalThis as {Bun?:unknown}).Bun!=='undefined')]:[local];
}
