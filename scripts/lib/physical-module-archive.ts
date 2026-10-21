import { moduleDefinition, modulePackageName, MODULE_API_VERSION } from '../../packages/xpod-cli/src/module-catalog';
import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
/** Regular-only archive; normalized modes match the ModuleStore inventory contract. */
export function writePhysicalModuleArchive(stage:string,output:string):void {
 if(!stage||!output||existsSync(output))throw new Error('Explicit fresh archive path required');
 const packed=spawnSync('python3',['-c',`import pathlib,tarfile,sys
p=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);names=sorted(p.rglob('*'))
assert all(not f.is_symlink() and (f.is_file() or f.is_dir()) for f in names)
files=[f for f in names if f.is_file()];assert len(files)<=50000
with tarfile.open(out,'w:gz',format=tarfile.USTAR_FORMAT,compresslevel=6) as t:
 for f in files:
  info=t.gettarinfo(str(f),arcname='package/'+f.relative_to(p).as_posix());info.mode=0o755 if f.stat().st_mode & 0o111 else 0o644;info.uid=0;info.gid=0;info.uname='';info.gname='';info.mtime=0
  with f.open('rb') as data:t.addfile(info,data)
`,path.resolve(stage),path.resolve(output)],{stdio:'inherit'});
 if(packed.error||packed.status!==0)throw new Error('Module archive failed');
}

export function packPhysicalModule(stage:string,output:string,adapter:{moduleId:string;entry:string;sourceRoot?:string;verifyReleaseMaterials?:(stage:string)=>void;verifyArchiveMaterials?:(stage:string)=>void}):{archive:string;sha256:string;integrity:string;members:number} {
 if(!stage||!output||existsSync(output))throw new Error('Explicit fresh archive path required');
 if(!/^[a-z][a-z0-9-]*$/u.test(adapter.moduleId)||!adapter.entry||path.isAbsolute(adapter.entry)||adapter.entry.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid module adapter identity/entry');
 const definition=moduleDefinition(adapter.moduleId);
 if(!definition||definition.id!==adapter.moduleId)throw new Error('Unregistered module role');
 const packageName=modulePackageName(adapter.moduleId,process.platform,process.arch);
 if(!packageName)throw new Error('Unsupported module product platform/architecture');
 const manifest=JSON.parse(readFileSync(path.join(stage,'package.json'),'utf8'));
 if(manifest.name!==packageName||typeof manifest.version!=='string'||!manifest.version)throw new Error('Physical product identity mismatch');
 if (manifest.private !== true) {
  if ((manifest.private !== false && manifest.private !== undefined) || !adapter.sourceRoot || typeof adapter.verifyReleaseMaterials !== 'function') throw new Error('Release archive requires actual source and material verification');
  const publication=JSON.parse(readFileSync(path.join(stage,'provenance/publication.json'),'utf8'));
  const commit=spawnSync('git',['rev-parse','HEAD'],{cwd:adapter.sourceRoot,encoding:'utf8'});
  const status=spawnSync('git',['status','--porcelain','--untracked-files=all'],{cwd:adapter.sourceRoot,encoding:'utf8'});
  if(publication.schemaVersion!==1||publication.mode!=='release'||publication.status!=='candidate'||publication.declaredSourceClean!==true||publication.version!==manifest.version||commit.status!==0||status.status!==0||status.stdout.trim()||publication.sourceCommit!==commit.stdout.trim())throw new Error('Release archive actual source identity/cleanliness mismatch');
  adapter.verifyReleaseMaterials(stage);
 }

 const names:string[]=[];
 const visit=(relative:string)=>{for(const name of readdirSync(path.join(stage,relative))){const f=relative?relative+'/'+name:name;const stat=lstatSync(path.join(stage,f));if(stat.isSymbolicLink())throw new Error('Product symlink rejected');if(stat.isDirectory())visit(f);else if(stat.isFile())names.push(f);else throw new Error('Product nonregular member rejected');}};visit('');names.sort();
 if(!names.includes(adapter.entry)||names.length>50000)throw new Error('Module entry missing or original member bound exceeded');
 const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
 const files=names.filter(f=>f!=='package.json').map(f=>{const b=readFileSync(path.join(stage,f));return {path:f,size:b.length,sha256:hash(b),mode:(lstatSync(path.join(stage,f)).mode&0o111)?0o755:0o644};});
 manifest.xpodModule={schemaVersion:1,id:adapter.moduleId,cliApiVersion:MODULE_API_VERSION,platform:process.platform,arch:process.arch,entry:adapter.entry,files};writeFileSync(path.join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 adapter.verifyArchiveMaterials?.(stage);
 writePhysicalModuleArchive(stage,output);
 const readback=spawnSync('python3',['-c',`import sys,tarfile,json,hashlib
with tarfile.open(sys.argv[1]) as t:
 members=t.getmembers();names=[m.name for m in members]
 assert len(names)==len(set(names)) and len(names)<=50000 and all(m.isfile() and m.name.startswith('package/') and '..' not in m.name.split('/') for m in members)
 by_name={m.name:m for m in members}
 manifest=json.load(t.extractfile(by_name['package/package.json']));rows=manifest['xpodModule']['files']
 assert set(names)-{'package/package.json'}=={'package/'+r['path'] for r in rows}
 for row in rows:
  member=by_name['package/'+row['path']];body=t.extractfile(member).read()
  assert len(body)==row['size'] and hashlib.sha256(body).hexdigest()==row['sha256'] and member.mode==row['mode']
`,path.resolve(output)],{stdio:'inherit'});
 if(readback.error||readback.status!==0)throw new Error('Actual module archive inventory readback failed');
 const bytes=readFileSync(output);return {archive:path.resolve(output),sha256:hash(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),members:files.length+1};
}
