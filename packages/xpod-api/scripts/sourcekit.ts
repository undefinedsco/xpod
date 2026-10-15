import { spawnSync } from 'node:child_process';

export interface ApiSourcekit { archive: string; index: string; sha256: string }
export interface SourcekitBudget { sourceMembers: number; sourceExpandedBytes: number; sourceStreamBytes: number; archiveBytes: number; combinedBytes: number; sourceInventoryDigestComputations: number }

/** Source material is verified as a stream and is never extracted or executed. */
export function verifyApiSourcekits(kits: ApiSourcekit[], runtimeExpandedBytes: number): SourcekitBudget {
  if (!kits.length || !Number.isSafeInteger(runtimeExpandedBytes) || runtimeExpandedBytes < 0) throw new Error('API sourcekit and explicit runtime byte budget required');
  const result = spawnSync('python3', ['-c', `
import sys,json,os,stat,hashlib,zlib,re
LIMIT=2*1024*1024*1024
MEMBERS=100000
INDEX_LIMIT=32*1024*1024
def fail(message): raise ValueError(message)
def pairs(rows):
 out={}
 for key,value in rows:
  if key in out: fail('duplicate JSON key')
  out[key]=value
 return out
def safe(value):
 return isinstance(value,str) and 0<len(value.encode('utf8'))<=4096 and not value.startswith('/') and '\\\\' not in value and not re.search(r'[\\x00-\\x1f\\x7f]',value) and all(x not in ('','.','..') for x in value.split('/'))
def regular(file):
 st=os.lstat(file)
 if not stat.S_ISREG(st.st_mode): fail('sourcekit material is not regular')
 return st.st_size
class Reader:
 def __init__(self,file,charge,expected_size,expected_hash):
  self.file=open(file,'rb');magic=self.file.read(2);self.file.seek(0)
  self.decoder=zlib.decompressobj(31) if magic==b'\\x1f\\x8b' else None
  self.pending=b'';self.ended=False;self.charge=charge;self.total=0
  self.raw_size=expected_size;self.raw_hash=expected_hash;self.raw_count=0;self.digest=hashlib.sha256()
 def raw(self,size):
  chunk=self.file.read(size);self.raw_count+=len(chunk)
  if self.raw_count>self.raw_size:fail('source archive grew during verification')
  self.digest.update(chunk);return chunk
 def finish(self):
  if self.raw_count!=self.raw_size or self.digest.hexdigest()!=self.raw_hash:fail('source archive changed during verification')
 def read(self,size):
  out=bytearray()
  while len(out)<size and not self.ended:
   wanted=min(65536,size-len(out))
   if self.decoder is None:
    chunk=self.raw(wanted)
    if not chunk:self.finish();self.ended=True
   else:
    if self.decoder.eof:
     if self.decoder.unused_data or self.pending or self.raw(1):fail('second gzip member or compressed trailing bytes')
     self.finish();self.ended=True;break
    if not self.pending:
     self.pending=self.raw(65536)
     if not self.pending:fail('truncated gzip stream')
    chunk=self.decoder.decompress(self.pending,wanted)
    self.pending=self.decoder.unconsumed_tail
    if self.decoder.eof and self.decoder.unused_data:fail('second gzip member or compressed trailing bytes')
   if chunk:
    self.total+=len(chunk);self.charge(len(chunk));out.extend(chunk)
  return bytes(out)
 def exact(self,size):
  value=self.read(size)
  if len(value)!=size:fail('truncated source tar')
  return value
 def close(self):self.file.close()
def octal(field):
 value=field.strip(b' \\0')
 if not value:return 0
 if not re.fullmatch(b'[0-7]+',value):fail('noncanonical tar integer')
 return int(value,8)
def text(field):
 value,separator,tail=field.partition(b'\\0')
 if separator and any(tail):fail('noncanonical tar text padding')
 return value.decode('utf8')
request=json.loads(sys.stdin.read(),object_pairs_hook=pairs)
runtime=request['runtimeExpandedBytes']
if not isinstance(runtime,int) or isinstance(runtime,bool) or runtime<0 or runtime>LIMIT: fail('runtime byte bound')
members=expanded=archive_bytes=decoded=inventory_digest_computations=0
for kit in request['kits']:
 if set(kit)!=set(('archive','index','sha256')) or not re.fullmatch('[a-f0-9]{64}',kit['sha256']): fail('invalid sourcekit binding')
 size=regular(kit['archive']); index_size=regular(kit['index'])
 if size>LIMIT or index_size>INDEX_LIMIT: fail('sourcekit material byte bound')
 archive_bytes+=size
 h=hashlib.sha256();compressed_count=0
 with open(kit['archive'],'rb') as stream:
  while True:
   chunk=stream.read(min(1024*1024,size-compressed_count+1))
   if not chunk:break
   compressed_count+=len(chunk)
   if compressed_count>size:fail('source archive actual compressed byte bound')
   h.update(chunk)
 if compressed_count!=size:fail('source archive compressed size drift')
 if h.hexdigest()!=kit['sha256']: fail('sourcekit archive drift')
 with open(kit['index'],'rb') as stream: index_bytes=stream.read(INDEX_LIMIT+1)
 if len(index_bytes)>INDEX_LIMIT or len(index_bytes)!=index_size:fail('sourcekit actual index byte bound')
 index=json.loads(index_bytes,object_pairs_hook=pairs)
 if type(index.get('schemaVersion')) is not int or index.get('schemaVersion')!=1 or index.get('role')!='source-only' or not safe(index.get('rootName')) or '/' in index['rootName'] or not isinstance(index.get('files'),list): fail('unknown sourcekit role/index')
 root=index['rootName']; rows=index['files']; expected={root+'/source-kit.json':(len(index_bytes),hashlib.sha256(index_bytes).hexdigest(),0o644)}
 members+=len(rows)+1
 if members>MEMBERS: fail('aggregate source member bound')
 expanded+=len(index_bytes)
 for row in rows:
  if set(row)!=set(('path','sha256','sizeBytes','mode')) or not safe(row['path']) or not re.fullmatch('[a-f0-9]{64}',row['sha256']) or row['mode'] not in (0o644,0o755) or not isinstance(row['sizeBytes'],int) or isinstance(row['sizeBytes'],bool) or row['sizeBytes']<0 or row['sizeBytes']>LIMIT: fail('invalid source inventory row')
  name=root+'/'+row['path']
  if name in expected: fail('duplicate source inventory path')
  expected[name]=(row['sizeBytes'],row['sha256'],row['mode']);expanded+=row['sizeBytes']
 origin_manifests={}
 if set(index)-set(('schemaVersion','role','rootName','files','originMappings')):fail('unknown sourcekit index field')
 if 'originMappings' in index:
  mappings=index['originMappings']
  if not isinstance(mappings,list) or not mappings or len(mappings)>len(rows):fail('invalid source origin mapping list')
  prefixes=set();origins=set();row_groups={};origin_lookup=[];owner_refs=[]
  for row in rows:
   parts=row['path'].split('/',2)
   if len(parts)==3 and parts[0]=='originals':row_groups.setdefault(parts[0]+'/'+parts[1],[]).append(dict(path=parts[2],sha256=row['sha256'],sizeBytes=row['sizeBytes'],mode=row['mode']))
  for mapping in mappings:
   if not isinstance(mapping,dict) or set(mapping)!=set(('prefix','origins')) or not re.fullmatch('originals/[a-f0-9]{64}',mapping.get('prefix','')) or not isinstance(mapping.get('origins'),list) or not mapping['origins']:fail('invalid source origin mapping')
   prefix=mapping['prefix']
   if prefix in prefixes:fail('duplicate source origin prefix')
   prefixes.add(prefix);files=row_groups.get(prefix,[]);manifest_row=next((row for row in files if row['path']=='package.json'),None)
   if not manifest_row or manifest_row['sizeBytes']>INDEX_LIMIT:fail('source origin manifest missing/oversized')
   identity=None;expected_identity=None
   for origin in mapping['origins']:
    if not isinstance(origin,dict) or set(origin)!=set(('path','inventorySHA256','manifest','owners')) or not safe(origin.get('path')) or origin['path'] in origins:fail('unsafe/duplicate source origin')
    origins.add(origin['path']);origin_lookup.append((origin['path'],prefix))
    if len(origins)>MEMBERS:fail('source origin metadata bound')
    manifest=origin['manifest']
    if not isinstance(manifest,dict) or set(manifest)!=set(('name','version','sha256')) or not isinstance(manifest['name'],str) or not manifest['name'] or not isinstance(manifest['version'],str) or not manifest['version'] or manifest['sha256']!=manifest_row['sha256']:fail('source origin manifest identity mismatch')
    if identity is None:
     expected_identity=hashlib.sha256(json.dumps(dict(name=manifest['name'],version=manifest['version'],files=sorted(files,key=lambda row:row['path'])),ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
     inventory_digest_computations+=1
    if prefix!='originals/'+expected_identity or origin['inventorySHA256']!=expected_identity or (identity is not None and identity!=manifest):fail('source origin inventory identity mismatch')
    identity=manifest
    owners=origin['owners']
    if not isinstance(owners,list) or not owners:fail('source origin owners missing')
    owner_seen=set()
    for owner in owners:
     if not isinstance(owner,dict) or set(owner)-set(('kind','from','sha256','specifier','ownerManifest','ownerManifestSHA256')) or not set(('kind','from','sha256')).issubset(owner) or owner['kind'] not in ('bundle-input','runtime-import','declaration','dependency') or not safe(owner['from']) or not re.fullmatch('[a-f0-9]{64}',owner['sha256']):fail('invalid source origin owner')
     if 'specifier' in owner and (not isinstance(owner['specifier'],str) or not owner['specifier'] or len(owner['specifier'].encode())>4096):fail('invalid source owner specifier')
     if ('ownerManifest' in owner)!=('ownerManifestSHA256' in owner):fail('incomplete source owner manifest')
     if 'ownerManifest' in owner and (not safe(owner['ownerManifest']) or not re.fullmatch('[a-f0-9]{64}',owner['ownerManifestSHA256'])):fail('invalid source owner manifest')
     key=json.dumps(owner,sort_keys=True,separators=(',',':'))
     if key in owner_seen:fail('duplicate source origin owner')
     owner_seen.add(key);owner_refs.append((owner['from'],owner['sha256']))
     if 'ownerManifest' in owner:owner_refs.append((owner['ownerManifest'],owner['ownerManifestSHA256']))
   origin_manifests[root+'/'+prefix+'/package.json']=identity
  if set(row_groups)!=prefixes:fail('source original root omitted from origin mappings')
  origin_lookup.sort(key=lambda row:len(row[0]),reverse=True)
  row_hashes={row['path']:row['sha256'] for row in rows}
  for source_path,source_hash in owner_refs:
   archived='canonical/'+source_path
   if archived not in row_hashes:
    match=next(((origin,prefix) for origin,prefix in origin_lookup if source_path.startswith(origin+'/')),None)
    if match is None:fail('source owner provenance not archived')
    origin,prefix=match;archived=prefix+'/'+source_path[len(origin)+1:]
   if row_hashes.get(archived)!=source_hash:fail('source owner provenance hash mismatch')

 if runtime+archive_bytes+expanded>LIMIT: fail('aggregate expanded byte bound')
 seen=set(); actual_bytes=0
 def charge(count):
  global decoded
  decoded+=count
  if runtime+archive_bytes+decoded>LIMIT:fail('actual decompressed stream byte bound')
 reader=Reader(kit['archive'],charge,size,kit['sha256'])
 try:
  while True:
   header=reader.exact(512)
   if not any(header):
    if any(reader.exact(512)):fail('invalid tar end marker')
    padding=(-reader.total)%10240
    tail=reader.read(padding+1)
    if any(tail) or len(tail) not in (0,padding):fail('noncanonical/nonzero/excess tar tail')
    if reader.read(1):fail('source tar trailing bytes')
    break
   # Reject every extended/sparse/link header before reading any of its body.
   if header[156:157] not in (b'0',b'\\0') or header[257:263]!=b'ustar\\0' or header[263:265]!=b'00':fail('unsupported source tar header type before body: decoded='+str(reader.total))
   if octal(header[148:156])!=sum(header[:148])+8*32+sum(header[156:]):fail('invalid tar checksum')
   if any(header[157:257]):fail('source tar link metadata forbidden')
   name=text(header[:100]);prefix=text(header[345:500]);name=prefix+'/'+name if prefix else name
   if not safe(name) or name not in expected or name in seen:fail('unsafe/unlisted/duplicate source archive member')
   size=octal(header[124:136]);mode=octal(header[100:108])
   declared_size,declared_hash,declared_mode=expected[name]
   if size!=declared_size or mode!=declared_mode:fail('source archive header mismatch')
   seen.add(name);digest=hashlib.sha256();count=0;manifest_bytes=bytearray() if name in origin_manifests else None
   while count<size:
    chunk=reader.exact(min(1024*1024,size-count));count+=len(chunk);actual_bytes+=len(chunk);digest.update(chunk)
    if manifest_bytes is not None:manifest_bytes.extend(chunk)
    if actual_bytes>LIMIT:fail('actual source content byte bound')
   if digest.hexdigest()!=declared_hash:fail('source archive bytes drift')
   if manifest_bytes is not None:
    package=json.loads(manifest_bytes);identity=origin_manifests[name]
    if not isinstance(package,dict) or package.get('name')!=identity['name'] or package.get('version')!=identity['version']:fail('archived source manifest identity drift')
   padding=reader.exact((-size)%512)
   if any(padding):fail('nonzero source file padding')
 finally:reader.close()
 if seen!=set(expected): fail('source archive material missing')
 if actual_bytes!=sum(row[0] for row in expected.values()): fail('source actual byte accounting mismatch')
print(json.dumps(dict(sourceMembers=members,sourceExpandedBytes=expanded,archiveBytes=archive_bytes,sourceStreamBytes=decoded,combinedBytes=runtime+archive_bytes+max(expanded,decoded),sourceInventoryDigestComputations=inventory_digest_computations)))
`,], { input: JSON.stringify({ kits, runtimeExpandedBytes }), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('API sourcekit verification failed: ' + (result.error?.message ?? result.stderr.trim()));
  return JSON.parse(result.stdout) as SourcekitBudget;
}
