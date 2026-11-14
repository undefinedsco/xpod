const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {inspectTarballBuffer,sha512Integrity}=require('./workspace-package-payload.cjs');
const {runPublicationCommand}=require('./lib/afs-publication-command.cjs');
const {libraryConsumerProbe}=require('./lib/afs-library-consumer.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function publicArchiveProbe(manifest){
  const specifiers=Object.entries(manifest.exports).filter(([key])=>key!=='./package.json').map(([key])=>manifest.name+(key==='.'?'':key.slice(1)));
  return libraryConsumerProbe+`\nconst fs=await import('node:fs'),path=await import('node:path');
const installed=fs.realpathSync(path.join(process.cwd(),'node_modules/@undefineds.co/xpod-afs'));
for(const specifier of ${JSON.stringify(specifiers)}){
 const url=import.meta.resolve(specifier), resolved=require.resolve(specifier);
 if(!fs.realpathSync(new URL(url)).startsWith(installed+path.sep)||!fs.realpathSync(resolved).startsWith(installed+path.sep))throw Error('export escaped archive');
 await import(specifier);require(specifier);
}
const library=require(path.join(installed,'dist/library.cjs'));
library.runtime.bindModuleRoot(installed);
const launcher=library.runtime.moduleLauncher();
if(launcher.length!==2||launcher[0]!==process.execPath||launcher[1]!==path.join(installed,'dist/entry.mjs')||!fs.statSync(launcher[1]).isFile())throw Error('generic launcher entry mismatch');
console.log(JSON.stringify({publicExports:true,launcherLocalEntry:true,platformLaunch:false}));\n`;
}
function verifyInstalledArchive(installed, entries){
  if(fs.lstatSync(installed).isSymbolicLink())throw new Error('Installed archive must not be a symlink');
  const expected=new Map(),directories=new Set();
  for(const member of entries){
    if(!member.path.startsWith('package/'))throw new Error('Unexpected archive root');
    const relative=member.path.slice(8);
    if(member.type==='directory'){directories.add(relative.replace(/\/$/,''));continue;}
    if(member.type!=='file'||expected.has(relative))throw new Error('Invalid archive inventory');
    expected.set(relative,member);
    let parent=path.posix.dirname(relative);while(parent!=='.'){directories.add(parent);parent=path.posix.dirname(parent);}
  }
  const seen=new Set();
  const walk=(directory,relative='')=>{
    for(const name of fs.readdirSync(directory)){
      const item=relative?relative+'/'+name:name,file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw new Error('Installed inventory link rejected');
      if(stat.isDirectory()){if(!directories.has(item))throw new Error('Unbound installed directory');walk(file,item);}
      else{
        const member=expected.get(item);
        if(!stat.isFile()||!member||(stat.mode&0o7777)!==member.mode||!fs.readFileSync(file).equals(member.content))throw new Error('Installed archive type/mode/bytes mismatch');
        seen.add(item);
      }
    }
  };walk(installed);
  if(seen.size!==expected.size)throw new Error('Missing installed archive member');
}
async function consumeClientPublication({receipt,publicationReceipt,publicationReceiptSHA256,registry,output,typescriptTool},execute=runPublicationCommand){
  const url=new URL(registry);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Explicit loopback dependency supply required');
  const publicationBytes=fs.readFileSync(publicationReceipt);
  if(hash(publicationBytes)!==publicationReceiptSHA256||JSON.stringify(JSON.parse(publicationBytes))!==JSON.stringify(receipt))throw new Error('Publication receipt binding mismatch');
  const tool=fs.readFileSync(typescriptTool.path);if(hash(tool)!==typescriptTool.sha256)throw new Error('Typecheck tool binding mismatch');
  const bytes=fs.readFileSync(receipt.archive.path);
  if(bytes.length!==receipt.archive.bytes||hash(bytes)!==receipt.archive.sha256||sha512Integrity(bytes)!==receipt.archive.integrity)throw new Error('Normal archive binding mismatch');
  const inspected=inspectTarballBuffer(bytes);
  if(inspected.manifest.name!=='@undefineds.co/xpod-afs'||inspected.manifest.private!==false||inspected.manifest.version!==receipt.version)throw new Error('Generic distribution identity required');
  const parent=path.dirname(path.resolve(output));
  if(fs.realpathSync(parent)!==parent)throw new Error('Canonical consumer parent required');
  for(let current=parent;;current=path.dirname(current)){if(fs.existsSync(path.join(current,'package.json')))throw new Error('Consumer must be outside package ancestors');if(path.dirname(current)===current)break;}
  if(fs.existsSync(output))throw new Error('Fresh consumer parent required');
  fs.mkdirSync(output,{recursive:false});const phases=[];let primary;
  try{
    for(const runtime of ['node','bun']){
      const root=path.join(output,runtime);fs.mkdirSync(root);const home=path.join(root,'home');fs.mkdirSync(home);
      const env={...process.env,HOME:home,NODE_PATH:'',NODE_OPTIONS:'',BUN_OPTIONS:'',BUN_INSTALL_CACHE_DIR:path.join(root,'cache'),NPM_CONFIG_USERCONFIG:path.join(root,'empty.npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(root,'global.npmrc')};
      for(const key of Object.keys(env))if(/^(?:npm_|NODE_AUTH_TOKEN|YARN_NPM_AUTH_TOKEN)/i.test(key))delete env[key];
      env.NPM_CONFIG_USERCONFIG=path.join(root,'empty.npmrc');env.NPM_CONFIG_GLOBALCONFIG=path.join(root,'global.npmrc');
      for(const name of ['empty.npmrc','global.npmrc'])fs.writeFileSync(path.join(root,name),'');
      fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'afs-normal-archive-consumer',private:true,type:'module'}));
      fs.writeFileSync(path.join(root,'bunfig.toml'),`[install]\nregistry = ${JSON.stringify(registry)}\n`);
      phases.push(await execute('bun',['add','--ignore-scripts','--no-cache','--registry',registry,receipt.archive.path],{cwd:root,env,evidence:output,label:runtime+'-archive-install'}));
      const installed=path.join(root,'node_modules/@undefineds.co/xpod-afs');
      verifyInstalledArchive(installed,inspected.entries);
      fs.writeFileSync(path.join(root,'probe.mjs'),publicArchiveProbe(inspected.manifest));
      phases.push(await execute(runtime,['probe.mjs'],{cwd:root,env,evidence:output,label:runtime+'-public-exports'}));
      fs.writeFileSync(path.join(root,'consumer.ts'),"import { LocalSolidFS } from '@undefineds.co/xpod-afs/workcopy'; import { getSqliteRuntime } from '@undefineds.co/xpod-afs/sqlite/SqliteRuntime'; const storage: typeof LocalSolidFS = LocalSolidFS; const sqlite: ReturnType<typeof getSqliteRuntime> = getSqliteRuntime(); void [storage, sqlite];\n");
      phases.push(await execute('node',[typescriptTool.path,'--noEmit','--strict','--skipLibCheck','--target','ES2021','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts'],{cwd:root,env,evidence:output,label:runtime+'-declarations'}));
      if(!fs.readFileSync(receipt.archive.path).equals(bytes)||!fs.readFileSync(publicationReceipt).equals(publicationBytes)||hash(fs.readFileSync(typescriptTool.path))!==typescriptTool.sha256)throw new Error('Consumer inputs changed');
      fs.rmSync(root,{recursive:true,force:true});
    }
  }catch(error){primary=error;}
  const result={kind:'afs-js-normal-archive-consumers',publicationReceipt:{path:publicationReceipt,bytes:publicationBytes.length,sha256:hash(publicationBytes)},archive:{...receipt.archive,name:inspected.manifest.name,version:inspected.manifest.version},compiler:{path:typescriptTool.path,actualPath:fs.realpathSync(typescriptTool.path),bytes:tool.length,sha256:hash(tool),authority:'caller-bound tool only; not independent producer admission'},passed:!primary,phases,installManager:'bun',runtimes:['node','bun'],registrySemanticsQualified:false,sourceQualified:false,releaseQualified:false,consumersRemoved:['node','bun'].every(name=>!fs.existsSync(path.join(output,name)))};
  fs.writeFileSync(path.join(output,'consumer.original.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  if(primary)throw primary;return result;
}
module.exports={consumeClientPublication,publicArchiveProbe,verifyInstalledArchive};
if(require.main===module){
  (async()=>{
    if(process.argv.length!==3)throw new Error('Expected one archive-consumer request file');
    const request=JSON.parse(fs.readFileSync(path.resolve(process.argv[2]),'utf8'));
    const bytes=fs.readFileSync(request.publicationReceipt);
    if(!/^[a-f0-9]{64}$/.test(request.publicationReceiptSHA256)||hash(bytes)!==request.publicationReceiptSHA256)throw new Error('Publication receipt binding mismatch');
    await consumeClientPublication({...request,receipt:JSON.parse(bytes)});
  })().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
}
