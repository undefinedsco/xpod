/** Actual Bun native-module exercises. This process grants no qualification.
 * The owned collector must retain its transcript and snapshot live mappings
 * after ready and before supplying the exact shutdown frame. */
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

export async function runRoleProbe({role,nonce,packageRoot,scratch,input,output}) {
  if (!['bun-node-addon','bun-sqlite-extension','inngest-cli'].includes(role) || !/^[a-f0-9]{32}$/.test(nonce)) throw Error('Exact role and owned nonce required');
  const iterator=input[Symbol.asyncIterator]();
  const require = createRequire(resolve(packageRoot,'package.json'));
  let close;
  try {
    if (role === 'bun-node-addon') {
      const {ClassicLevel} = require('classic-level');
      const database = new ClassicLevel(resolve(scratch,'classic-level'),{valueEncoding:'utf8'});
      close = () => database.close();
      await database.open();
      await database.put('abi-'+nonce,nonce);
      if (await database.get('abi-'+nonce) !== nonce) throw Error('Actual classic-level readback failed');
      await database.del('abi-'+nonce);
    } else if (role === 'inngest-cli') {
      // Actual product process stays alive across the membership hook. Bun is
      // only its harness; the collector resolves the CLI's own executable PID.
      const child = Bun.spawn([resolve(packageRoot,'node_modules/inngest-cli/bin/inngest'),
        'dev','--no-discovery','--host','127.0.0.1','--port','8288'],
        {stdin:'ignore',stdout:2,stderr:2});
      close = async () => {
        child.kill('SIGTERM');
        const code = await child.exited;
        if (code !== 0 && code !== 143) throw Error('Actual Inngest termination differs: '+code);
      };
      for (;;) {
        if (child.exitCode !== null) throw Error('Actual Inngest exited before health');
        try {
          const response=await fetch('http://127.0.0.1:8288/health');
          if (response.status!==200) throw Error('Inngest health status differs');
          const reader=response.body?.getReader();
          if (!reader) throw Error('Actual bounded Inngest health body required');
          const parts=[];let length=0;
          try {
            for (;;) {const row=await reader.read();if(row.done)break;length+=row.value.length;if(length>4096)throw Error('Inngest health body exceeds fixed bound');parts.push(Buffer.from(row.value));}
          } finally {await reader.cancel();}
          const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
          if (body.status!==200 || body.message!=='OK' || Object.keys(body).length!==2) throw Error('Inngest health body differs');
          break;
        } catch (error) {
          if (child.exitCode !== null) throw error;
          await new Promise(done=>setTimeout(done,50));
        }
      }
    } else {
      const {Database} = await import('bun:sqlite');
      const database = new Database(':memory:');
      close = () => database.close();
      const extension = require('sqlite-vec');
      database.loadExtension(extension.getLoadablePath());
      const row = database.query('SELECT vec_version() AS version').get();
      if (!row || typeof row.version !== 'string' || row.version.length === 0) throw Error('Actual sqlite-vec query failed');
    }
    await output(JSON.stringify({phase:'ready',role,nonce})+'\n');
    const frame=await iterator.next();
    const expected=JSON.stringify({phase:'shutdown',role,nonce});
    if (frame.done || typeof frame.value!=='string' || Buffer.byteLength(frame.value)>256 || frame.value!==expected) throw Error('Exact post-membership shutdown frame required');
    await close(); close=undefined;
    await output(JSON.stringify({phase:'closed',role,nonce})+'\n');
  } finally { if(close) await close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length!==4) throw Error('role and nonce arguments required');
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  try {
    await runRoleProbe({role:process.argv[2],nonce:process.argv[3],packageRoot:'/app',scratch:'/scratch',input:lines,
      output:line=>new Promise((done,reject)=>process.stdout.write(line,error=>error?reject(error):done()))});
  } finally { lines.close(); }
}
