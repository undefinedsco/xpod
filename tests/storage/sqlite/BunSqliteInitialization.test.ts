import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';

const factory = resolve('src/storage/SqliteRuntime.ts');
function cold(script: string, command: string): ReturnType<typeof spawnSync> {
  return spawnSync('bun', ['--no-env-file', '-e', script], {
    encoding: 'utf8', env: { ...process.env, XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: command, XPOD_SQLITE_RUNTIME: 'bun-sqlite' }, timeout: 15_000,
  });
}
describe('macOS Bun process SQLite choice', () => {
  it('allows source fake commands to change while both factory surfaces share ordinary SQLite', () => {
    const result = cold(`const {createSqliteRuntime,getSqliteRuntime}=require(${JSON.stringify(factory)});
      for(const command of ['/tmp/source-a/xpod_qlever_local_runtime','/tmp/source-b/xpod_qlever_local_runtime']){
        process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=command;
        for(const r of [createSqliteRuntime('bun-sqlite'),getSqliteRuntime()]){
          if(r.kind!=='bun-sqlite')throw Error('wrong backend');const db=r.openDatabase(':memory:');db.exec('CREATE TABLE t(v); INSERT INTO t VALUES(41)');
          if(db.prepare('SELECT v FROM t').get().v!==41)throw Error('readback');db.close();}}
    `, '/tmp/source-a/xpod_qlever_local_runtime');
    expect(result.status, String(result.stderr)).toBe(0);
  });
  it.each(['independent', 'singleton'])('rejects missing selected manifest before business DB via %s', (surface) => {
    const root = mkdtempSync(resolve('.test-data/bun-sqlite-selected-'));
    try {
      const command = join(root, 'qlever/bin/xpod_qlever_local_runtime'); mkdirSync(join(root, 'qlever/bin'), {recursive:true});
      const db = join(root, 'business.sqlite');
      if(process.platform!=='darwin'){const result=cold(`require(${JSON.stringify(factory)}).getSqliteRuntime().openDatabase(':memory:').close()`,command);expect(result.status).toBe(0);return;}
      const result = cold(`const f=require(${JSON.stringify(factory)});try{
        const r=${surface === 'singleton' ? 'f.getSqliteRuntime()' : "f.createSqliteRuntime('bun-sqlite')"};
        r.openDatabase(${JSON.stringify(db)});throw Error('accepted missing manifest');
      }catch(e){if(!String(e).includes('SQLite artifact'))throw e;}`, command);
      expect(result.status, String(result.stderr)).toBe(0); expect(existsSync(db)).toBe(false);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
  it.each(['independent', 'singleton', 'existing'])('rejects late release selection via %s before business DB', (surface) => {
    const root=mkdtempSync(resolve('.test-data/bun-sqlite-late-'));
    try {
      const db=join(root,'business.sqlite'), command=join(root,'qlever/bin/xpod_qlever_local_runtime');
      if(process.platform!=='darwin'){const result=cold(`require(${JSON.stringify(factory)}).getSqliteRuntime().openDatabase(':memory:').close()`,command);expect(result.status).toBe(0);return;}
      const result=cold(`const f=require(${JSON.stringify(factory)});const old=f.getSqliteRuntime();old.openDatabase(':memory:').close();
        process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND=${JSON.stringify(command)};
        try{const r=${surface==='existing'?'old':surface==='singleton'?'f.getSqliteRuntime()':"f.createSqliteRuntime('bun-sqlite')"};
        r.openDatabase(${JSON.stringify(db)});throw Error('accepted late selection');}catch(e){if(!String(e).includes('initialization conflict'))throw e;}
      `,'/tmp/source/xpod_qlever_local_runtime');
      expect(result.status,String(result.stderr)).toBe(0);expect(existsSync(db)).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

// Invalid artifacts are negative fixtures, never packaged-library positive evidence.
describe('selected macOS SQLite artifact validation', () => {
  it.each(['missing-library','digest','size','ambiguous','traversal','symlink','unsupported-abi','load-false','load-throws'])('%s refuses before DB and preserves original failure', (fault) => {
    const root=mkdtempSync(resolve('.test-data/bun-sqlite-invalid-'));
    try {
      const payload=join(root,'qlever'), command=join(payload,'bin/xpod_qlever_local_runtime');
      mkdirSync(join(payload,'bin'),{recursive:true});mkdirSync(join(payload,'lib'),{recursive:true});
      writeFileSync(command,'negative fixture runtime'); const library=join(payload,'lib/sqlite.dylib');writeFileSync(library,'negative fixture library');
      const record=(path:string,role?:string)=>({path,role,size:Buffer.byteLength(path.includes('bin/')?'negative fixture runtime':'negative fixture library'),sha256:createHash('sha256').update(path.includes('bin/')?'negative fixture runtime':'negative fixture library').digest('hex')});
      const files=[record('bin/xpod_qlever_local_runtime'),record('lib/sqlite.dylib','sqlite-runtime')];
      let abi=7;
      if(fault==='missing-library')rmSync(library);
      if(fault==='digest')files[1].sha256='0'.repeat(64);
      if(fault==='size')files[1].size++;
      if(fault==='ambiguous')files.push({...files[1]});
      if(fault==='traversal')files[1].path='../escape.dylib';
      if(fault==='symlink'){rmSync(library);writeFileSync(join(root,'escape.dylib'),'negative fixture library');symlinkSync(join(root,'escape.dylib'),library);}
      if(fault==='unsupported-abi')abi=0;
      writeFileSync(join(payload,'manifest.json'),JSON.stringify({schemaVersion:1,adapterAbiVersion:abi,physicalBackendAbiVersion:7,qlever:{repository:'https://example.invalid/negative',commit:'1'.repeat(40),patchSeriesSha256:'2'.repeat(64)},artifacts:files}));
      const business=join(root,'business.sqlite');
      if(process.platform!=='darwin'){expect(cold(`require(${JSON.stringify(factory)}).getSqliteRuntime().openDatabase(':memory:').close()`,command).status).toBe(0);return;}
      const helper=resolve('src/storage/sqlite/backends/BunSqliteInitialization.ts');
      const result=cold(`const f=require(${JSON.stringify(factory)});let first;
        try{${fault==='load-false'||fault==='load-throws'?`require(${JSON.stringify(helper)}).initializeBunSqlite({setCustomSQLite(){${fault==='load-false'?'return false;':"throw Error('injected loading error');"}}});`:''}
          f.getSqliteRuntime().openDatabase(${JSON.stringify(business)});throw Error('accepted artifact');
        }catch(e){if(!String(e).includes('SQLite artifact'))throw e;first=e;}
        process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND='/tmp/source/xpod_qlever_local_runtime';
        try{f.createSqliteRuntime('bun-sqlite');throw Error('failure healed');}catch(e){if(e!==first)throw Error('original failure lost');}
      `,command);
      expect(result.status,String(result.stderr)).toBe(0);expect(existsSync(business)).toBe(false);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});

it('source-only ordinary disk SQLite is usable and unavailable vec rejects explicitly', () => {
  const root=mkdtempSync(resolve('.test-data/bun-sqlite-source-'));
  try {
    const store=resolve('src/storage/vector/SqliteVectorStore.ts');
    // The ordinary disk positive uses an owned path; extension error is platform-specific.
    const real=cold(`(async()=>{const {getSqliteRuntime}=require(${JSON.stringify(factory)});
      const db=getSqliteRuntime().openDatabase(${JSON.stringify(join(root,'ordinary.sqlite'))});db.exec('CREATE TABLE t(v);INSERT INTO t VALUES(41)');if(db.prepare('SELECT v FROM t').get().v!==41)throw Error('ordinary disk');db.close();
      if(process.platform==='darwin'){const {SqliteVectorStore}=require(${JSON.stringify(store)});const v=new SqliteVectorStore({connectionString:${JSON.stringify(join(root,'vector.sqlite'))}});
        try{await v.getVector('missing',41);throw Error('empty successful vector');}catch(e){if(!String(e).includes('does not support dynamic extension loading'))throw e;}finally{await v.close();}}
    })().catch(e=>{console.error(e);process.exit(1)})`,'/tmp/source/xpod_qlever_local_runtime');
    expect(real.status,String(real.stderr)).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('freezes verified resolved library path even when manifest and library bytes match (synthetic path contract only)', () => {
  const root=mkdtempSync(resolve('.test-data/bun-sqlite-path-choice-'));
  try {
    const payload=join(root,'qlever');mkdirSync(join(payload,'bin'),{recursive:true});mkdirSync(join(payload,'lib'),{recursive:true});
    const command=join(payload,'bin/xpod_qlever_local_runtime');writeFileSync(command,'runtime negative fixture');
    for(const file of ['a.dylib','b.dylib'])writeFileSync(join(payload,'lib',file),'synthetic same bytes');
    const link=join(payload,'lib/sqlite.dylib');symlinkSync('a.dylib',link);
    const artifacts=[{path:'bin/xpod_qlever_local_runtime',size:24,sha256:createHash('sha256').update('runtime negative fixture').digest('hex')},{path:'lib/sqlite.dylib',role:'sqlite-runtime',size:20,sha256:createHash('sha256').update('synthetic same bytes').digest('hex')}];
    writeFileSync(join(payload,'manifest.json'),JSON.stringify({schemaVersion:1,adapterAbiVersion:7,physicalBackendAbiVersion:7,qlever:{repository:'https://example.invalid/negative',commit:'1'.repeat(40),patchSeriesSha256:'2'.repeat(64)},artifacts}));
    if(process.platform!=='darwin'){expect(cold(`require(${JSON.stringify(factory)}).getSqliteRuntime().openDatabase(':memory:').close()`,command).status).toBe(0);return;}
    const helper=resolve('src/storage/sqlite/backends/BunSqliteInitialization.ts');
    const result=cold(`const {initializeBunSqlite}=require(${JSON.stringify(helper)});let calls=0;const mock={setCustomSQLite(){calls++;return true}};
      initializeBunSqlite(mock);require('node:fs').unlinkSync(${JSON.stringify(link)});require('node:fs').symlinkSync('b.dylib',${JSON.stringify(link)});
      try{initializeBunSqlite(mock);throw Error('library path change accepted');}catch(e){if(!String(e).includes('initialization conflict'))throw e;}
      if(calls!==1)throw Error('loaded replacement');`,command);
    expect(result.status,String(result.stderr)).toBe(0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
