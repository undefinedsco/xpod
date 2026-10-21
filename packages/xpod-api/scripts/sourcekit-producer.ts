import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, unlinkSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyApiSourcekits, type ApiSourcekit, type SourcekitBudget } from './sourcekit';

export interface ApiSourceRoot {
  directory: string;
  prefix: string;
  owners?: ApiSourceOwner[];
  origins?: ApiSourceOrigin[];
  /** Explicit canonical files, or a complete installed distribution excluding nested package roots. */
  files?: string[];
}

/** Stream complete original files into USTAR/gzip; never stage a second expanded source tree. */
export function writeApiSourcekit(output: string, roots: ApiSourceRoot[], runtimeExpandedBytes: number): { kit: ApiSourcekit; budget: SourcekitBudget } {
  if (!roots.length) throw new Error('Explicit API original source roots required');
  verifySourceOrigins(roots);
  const result = spawnSync('python3', ['-c', sourcekitProducerProgram], { input: JSON.stringify({ output, roots, runtimeExpandedBytes }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('API sourcekit production failed: ' + (result.error?.message ?? result.stderr.trim()));
  const kit = JSON.parse(result.stdout) as ApiSourcekit;
  try { const budget = verifyApiSourcekits([kit], runtimeExpandedBytes); verifySourceOrigins(roots); return { kit, budget }; }
  catch (error) { unlinkSync(kit.archive); unlinkSync(kit.index); rmdirSync(output); throw error; }
}

/** Recompute the exact original inventory without emitting another archive. */
export function verifyApiSourcekitRoots(kit: ApiSourcekit, roots: ApiSourceRoot[], runtimeExpandedBytes: number): void {
  const size = lstatSync(kit.index).size;
  if (size > 32 * 1024 * 1024) throw new Error('API sourcekit index byte bound');
  verifySourceOrigins(roots);
  if (!sourceInventory(roots, runtimeExpandedBytes).equals(readFileSync(kit.index))) throw new Error('API original sourcekit inventory drift');
}

export interface ApiSourceOwner {
  kind: 'bundle-input' | 'runtime-import' | 'declaration' | 'dependency';
  from: string;
  sha256: string;
  specifier?: string;
  ownerManifest?: string;
  ownerManifestSHA256?: string;
}
export interface ApiSourceOrigin {
  directory: string;
  path: string;
  inventorySHA256: string;
  manifest: { name: string; version: string; sha256: string };
  owners: ApiSourceOwner[];
}
interface SourceInventoryRow { path: string; sha256: string; sizeBytes: number; mode: number }
const sourceDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Same streaming inventory pass as production, without creating an archive. */
function sourceInventory(roots: ApiSourceRoot[], runtimeExpandedBytes: number): Buffer {
  const result = spawnSync('python3', ['-c', sourcekitProducerProgram], {
    input: JSON.stringify({ mode: 'plan', roots, output: '', runtimeExpandedBytes }), encoding: null, maxBuffer: 33 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('API original source inventory failed: ' + (result.error?.message ?? result.stderr.toString().trim()));
  return result.stdout;
}

/** Store byte/mode-identical whole distributions once while preserving all physical origins. */
export function deduplicateApiSourceRoots(physicalRoots: ApiSourceRoot[]): ApiSourceRoot[] {
  if (physicalRoots.some(root => root.origins)) throw new Error('Physical source roots must not already contain aliases');
  if (!physicalRoots.some(root => !root.files)) return physicalRoots;
  const authority = physicalRoots.find(root => root.files)?.directory;
  if (!authority) throw new Error('Canonical source authority required for distribution aliases');
  for (const root of physicalRoots) { const relative = path.relative(authority, root.directory); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Source origin outside canonical authority'); }
  const inventory = JSON.parse(sourceInventory(physicalRoots, 0).toString('utf8')) as { files: SourceInventoryRow[] };
  const entries = new Map<string, SourceInventoryRow[]>();
  const byPrefix = new Map(physicalRoots.filter(root => !root.files).map(root => [root.prefix, root]));
  for (const row of inventory.files) {
    const parts = row.path.split('/'); let prefix: string | undefined;
    for (let length = parts.length - 1; length > 0; length--) { const candidate = parts.slice(0, length).join('/'); if (byPrefix.has(candidate)) { prefix = candidate; break; } }
    if (!prefix) continue;
    const rows = entries.get(prefix) ?? [];
    rows.push({path: row.path.slice(prefix.length + 1), sha256: row.sha256, sizeBytes: row.sizeBytes, mode: row.mode});
    entries.set(prefix, rows);
  }
  const groups = new Map<string, ApiSourceRoot>();
  for (const root of physicalRoots.filter(root => !root.files).sort((a,b) => Buffer.compare(Buffer.from(a.directory), Buffer.from(b.directory)))) {
    const rows = entries.get(root.prefix);
    if (!rows?.length) throw new Error('Original distribution inventory missing');
    rows.sort((a,b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const manifestRow = rows.find(row => row.path === 'package.json');
    const manifestBytes = readFileSync(root.directory + '/package.json');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifestRow || manifestRow.sha256 !== sourceDigest(manifestBytes) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Original distribution manifest identity mismatch');
    const identity = sourceDigest(JSON.stringify({name: manifest.name, version: manifest.version, files: rows}));
    const originPath = path.relative(authority, root.directory).split(path.sep).join('/');
    if (!originPath || !(root.owners?.length)) throw new Error('Actual source origin path and owner facts required');
    const origin: ApiSourceOrigin = {directory: root.directory, path: originPath, inventorySHA256: identity,
      manifest: {name: manifest.name, version: manifest.version, sha256: manifestRow.sha256},
      owners: [...new Map((root.owners ?? []).map(owner => [JSON.stringify(owner), owner])).values()].sort((a,b) => Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))))};
    const existing = groups.get(identity);
    if (existing) existing.origins!.push(origin);
    else groups.set(identity, {directory: root.directory, prefix: 'originals/' + identity, origins: [origin]});
  }
  return [...physicalRoots.filter(root => root.files), ...[...groups.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([,root]) => root)];
}

/** Every alias is reread; an unchanged representative cannot hide another origin's drift. */
function verifySourceOrigins(roots: ApiSourceRoot[]): void {
  if (!roots.some(root => root.origins)) return;
  const physical: ApiSourceRoot[] = [], directories = new Set<string>();
  for (const root of roots) {
    if (root.files) { if (root.origins) throw new Error('Canonical source must not contain distribution aliases'); physical.push(root); continue; }
    if (!root.origins?.length) throw new Error('Distribution origin mapping missing');
    for (const origin of root.origins) {
      if (directories.has(origin.directory)) throw new Error('Duplicate physical source origin');
      directories.add(origin.directory);
      physical.push({directory: origin.directory, prefix: 'physical/' + sourceDigest(origin.directory), owners: origin.owners});
    }
  }
  const actual = deduplicateApiSourceRoots(physical);
  if (JSON.stringify(actual) !== JSON.stringify(roots)) throw new Error('API source origin inventory/mapping drift');
}

const sourcekitProducerProgram = `
import sys,os,json,stat,hashlib,tarfile,gzip
LIMIT=2*1024*1024*1024
request=json.load(sys.stdin);out=request['output'];roots=request['roots'];runtime=request['runtimeExpandedBytes']
if type(runtime)!=int or runtime<0 or runtime>LIMIT:raise ValueError('runtime byte bound')
if request.get('mode')!='plan' and os.path.lexists(out):raise ValueError('fresh sourcekit directory required')
def safe(value):return isinstance(value,str) and 0<len(value.encode())<=4096 and not value.startswith('/') and '\\\\' not in value and all(x not in ('','.','..') for x in value.split('/')) and not any(ord(c)<32 or ord(c)==127 for c in value)
def regular(root,relative):
 if not safe(relative):raise ValueError('unsafe original source path')
 current=root
 for part in relative.split('/'):
  current=os.path.join(current,part)
  if stat.S_ISLNK(os.lstat(current).st_mode):raise ValueError('original source symlink')
 if not stat.S_ISREG(os.lstat(current).st_mode):raise ValueError('original source not regular')
 return current
entries={};signatures={};expanded=0
def signature(st):return (st.st_dev,st.st_ino,st.st_size,st.st_mode,st.st_mtime_ns,st.st_ctime_ns)
def open_original(file):
 fd=os.open(file,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 if not stat.S_ISREG(os.fstat(fd).st_mode):
  os.close(fd);raise ValueError('original source not regular on open')
 return os.fdopen(fd,'rb')
for source in roots:
 root=source['directory'];prefix=source['prefix']
 if not os.path.isabs(root) or os.path.realpath(root)!=root or not os.path.isdir(root) or not safe(prefix):raise ValueError('invalid original source root')
 names=source.get('files')
 if names is None:
  names=[]
  for directory,dirs,files in os.walk(root,followlinks=False):
   for name in dirs+files:
    if os.path.islink(os.path.join(directory,name)):raise ValueError('original distribution symlink')
   dirs[:]=sorted(name for name in dirs if name not in ('node_modules','.git','.test-data'))
   names.extend(os.path.relpath(os.path.join(directory,name),root).replace(os.sep,'/') for name in sorted(files))
 for relative in names:
  source_file=regular(root,relative);name=prefix+'/'+relative
  if not safe(name) or name in entries:raise ValueError('duplicate/unsafe original source member')
  st=os.stat(source_file);size=st.st_size;expanded+=size
  if expanded+runtime>LIMIT or len(entries)+2>100000:raise ValueError('sourcekit aggregate budget')
  digest=hashlib.sha256();count=0
  with open_original(source_file) as stream:
   if signature(os.fstat(stream.fileno()))!=signature(st):raise ValueError('original source changed before hashing')
   while True:
    chunk=stream.read(min(1024*1024,size-count+1))
    if not chunk:break
    count+=len(chunk)
    if count>size:raise ValueError('original source grew')
    digest.update(chunk)
   if signature(os.fstat(stream.fileno()))!=signature(st):raise ValueError('original source changed while hashing')
  if count!=size or signature(os.lstat(source_file))!=signature(st):raise ValueError('original source size/mode drift')
  mode=0o755 if st.st_mode&0o111 else 0o644
  # Validate USTAR path representability before creating any output.
  info=tarfile.TarInfo('source/'+name);info.size=size;info.mode=mode;info.tobuf(format=tarfile.USTAR_FORMAT)
  entries[name]=(source_file,size,digest.hexdigest(),mode);signatures[name]=signature(st)
metadata=dict(schemaVersion=1,role='source-only',rootName='source')
origin_mappings=[]
for source in roots:
 if source.get('origins'):
  origin_mappings.append(dict(prefix=source['prefix'],origins=[{key:value for key,value in origin.items() if key!='directory'} for origin in source['origins']]))
if origin_mappings:metadata['originMappings']=origin_mappings
parts=[json.dumps(metadata,ensure_ascii=False,separators=(',',':')).encode()[:-1]+b',"files":['];index_size=len(parts[0])+2
if index_size>32*1024*1024:raise ValueError('sourcekit index byte bound')
for name,row in sorted(entries.items()):
 part=json.dumps(dict(path=name,sizeBytes=row[1],sha256=row[2],mode=row[3]),ensure_ascii=False,separators=(',',':')).encode()
 if len(parts)>1:part=b','+part
 index_size+=len(part)
 if index_size>32*1024*1024:raise ValueError('sourcekit index byte bound')
 parts.append(part)
index=b''.join(parts)+b']}'
stream_bytes=1024+512+((len(index)+511)//512)*512+sum(512+((row[1]+511)//512)*512 for row in entries.values())
stream_bytes=((stream_bytes+10239)//10240)*10240
if runtime+stream_bytes>LIMIT:raise ValueError('sourcekit stream byte budget')
if request.get('mode')=='plan':
 sys.stdout.buffer.write(index);sys.exit(0)
os.makedirs(out)
archive=os.path.join(out,'originals.tgz');index_path=os.path.join(out,'source-kit.json')
try:
 with open(index_path,'xb') as stream:stream.write(index)
 class BoundWriter:
  def __init__(self,stream):self.stream=stream;self.count=0
  def write(self,data):
   self.count+=len(data)
   if runtime+stream_bytes+self.count>LIMIT:raise ValueError('sourcekit compressed byte budget')
   return self.stream.write(data)
  def flush(self):return self.stream.flush()
 with open(archive,'xb') as raw:
  with gzip.GzipFile(filename='',mode='wb',fileobj=BoundWriter(raw),mtime=0,compresslevel=6) as compressed:
   with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.USTAR_FORMAT) as tar:
    import io
    info=tarfile.TarInfo('source/source-kit.json');info.size=len(index);info.mode=0o644;tar.addfile(info,io.BytesIO(index))
    for name,(source_file,size,digest,mode) in sorted(entries.items()):
     info=tarfile.TarInfo('source/'+name);info.size=size;info.mode=mode
     class CheckedReader:
      def __init__(self,file):self.file=file;self.digest=hashlib.sha256();self.count=0
      def read(self,count):
       data=self.file.read(count);self.digest.update(data);self.count+=len(data);return data
     with open_original(source_file) as stream:
      if signature(os.fstat(stream.fileno()))!=signatures[name]:raise ValueError('original source changed before streaming')
      checked=CheckedReader(stream);tar.addfile(info,checked)
      if checked.count!=size or checked.digest.hexdigest()!=digest or stream.read(1) or signature(os.fstat(stream.fileno()))!=signatures[name] or signature(os.lstat(source_file))!=signatures[name]:raise ValueError('original source changed during streaming')
 digest=hashlib.sha256()
 with open(archive,'rb') as stream:
  while True:
   chunk=stream.read(1024*1024)
   if not chunk:break
   digest.update(chunk)
 print(json.dumps(dict(archive=archive,index=index_path,sha256=digest.hexdigest())))
except:
 for file in (archive,index_path):
  if os.path.isfile(file):os.unlink(file)
 os.rmdir(out)
 raise
`;
