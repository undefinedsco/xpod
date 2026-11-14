"""Pure bounded source archive observation. No source or license authority."""
import bz2,hashlib,io,lzma,posixpath,re,tarfile,zlib
CHUNK=65536

def need(value,why):
 if not value:raise ValueError('Native license archive: '+why)

def inspect_archive(stream,expected_bytes,expected_sha256,*,check,charge_read,charge_expanded,maximum_expanded_bytes,maximum_text_bytes,selected_members=()):
 need(type(expected_bytes)is int and expected_bytes>0 and re.fullmatch('[a-f0-9]{64}',expected_sha256),'original identity')
 need(type(maximum_expanded_bytes)is int and maximum_expanded_bytes>0 and type(maximum_text_bytes)is int and maximum_text_bytes>=0,'caller limits')
 def canonical(name):return bool(name) and not name.startswith('/') and '\\' not in name and not re.search('[\x00-\x1f\x7f]',name) and all(p not in ('','.','..')for p in name.split('/'))
 selected=set()
 for name in selected_members:
  need(isinstance(name,str)and canonical(name)and name not in selected,'canonical unique selected member')
  selected.add(name)
 seen_selected=set()
 class Original(io.RawIOBase):
  def __init__(self):self.count=0;self.digest=hashlib.sha256()
  def readable(self):return True
  def read(self,n=-1):
   check();need(0<=n<=CHUNK,'bounded original read request');data=stream.read(n);check();need(isinstance(data,bytes) and len(data)<=n,'actual original read');charge_read(len(data));check();self.count+=len(data);need(self.count<=expected_bytes,'original overflow');self.digest.update(data);return data
  def readinto(self,b):
   data=self.read(min(len(b),CHUNK));b[:len(data)]=data;return len(data)
 raw=Original();buffered=io.BufferedReader(raw,buffer_size=CHUNK);magic=buffered.peek(6)[:6]
 kind='gzip' if magic.startswith(b'\x1f\x8b') else 'xz' if magic==b'\xfd7zXZ\x00' else 'bz2' if magic.startswith(b'BZh') else 'plain'
 class Decoder:
  def __init__(self):self.engine=zlib.decompressobj(31) if kind=='gzip' else lzma.LZMADecompressor() if kind=='xz' else bz2.BZ2Decompressor();self.pending=b'';self.finished=False
  def read(self,n):
   output=[];remaining=n
   while remaining and not self.finished:
    check()
    if self.engine.eof:
     need(not self.engine.unused_data and not self.pending and buffered.read(1)==b'','compressed trailing bytes');self.finished=True;break
    wants_input=not self.pending if kind=='gzip' else self.engine.needs_input
    if wants_input:
     self.pending=buffered.read(CHUNK);need(self.pending,'compressed original truncated')
    data=self.engine.decompress(self.pending,remaining)
    self.pending=self.engine.unconsumed_tail if kind=='gzip' else b''
    output.append(data);remaining-=len(data)
   return b''.join(output)
  def close(self):pass
 decoder=buffered if kind=='plain' else Decoder()
 class Expanded:
  def __init__(self):self.count=0;self.tail=b''
  def read(self,n):
   check();need(0<=n<=CHUNK,'bounded expanded read request');data=decoder.read(n);check();charge_expanded(len(data));check();self.count+=len(data);need(self.count<=maximum_expanded_bytes,'expanded ceiling');self.tail=(self.tail+data)[-2*CHUNK:];return data
 expanded=Expanded();rows=[];texts=[];selected_texts=[];names=set();text_bytes=0
 try:
  with tarfile.open(fileobj=expanded,mode='r|',bufsize=10240)as archive:
   for item in archive:
    check();need(item.sparse is None and not any(key.startswith('GNU.sparse') for key in item.pax_headers),'sparse source member unsupported');name=item.name.rstrip('/')
    need(canonical(name)and name not in names and len(names)<100000,'canonical unique member');names.add(name)
    need(item.mode>=0 and item.mode<=0o7777,'member mode')
    if item.isdir():need(item.size==0,'directory payload');need(name not in selected,'selected member not regular');rows.append(dict(path=name,type='directory',bytes=0,mode=item.mode));continue
    if item.issym():
     need(item.size==0,'symlink payload');need(name not in selected,'selected member not regular');target=item.linkname;resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target));need(target and not target.startswith('/')and '\\'not in target and not re.search('[\x00-\x1f\x7f]',target)and resolved!='..'and not resolved.startswith('../'),'contained link');rows.append(dict(path=name,type='symlink',bytes=0,mode=item.mode,target=target));continue
    need(item.isfile(),'unsupported member type');is_selected=name in selected
    if is_selected:seen_selected.add(name)
    digest=hashlib.sha256();count=0;parts=[];retain=bool(re.match(r'^(license|licence|copying|notice|copyright)([._-].*)?$',posixpath.basename(name),re.I));keep=retain or is_selected
    if keep:need(text_bytes+item.size<=maximum_text_bytes,'notice text ceiling')
    with archive.extractfile(item)as member:
     while True:
      check();block=member.read(CHUNK);check()
      if not block:break
      count+=len(block);digest.update(block)
      if keep:parts.append(block)
    need(count==item.size,'member truncated');row=dict(path=name,type='file',mode=item.mode,bytes=count,sha256=digest.hexdigest());rows.append(row)
    if retain:
     text_bytes+=count;text=b''.join(parts);texts.append(dict(**row,text=text))
     if is_selected:selected_texts.append(dict(path=name,bytes=count,sha256=row['sha256'],text=text))
    elif is_selected:
     text_bytes+=count;selected_texts.append(dict(path=name,bytes=count,sha256=row['sha256'],text=b''.join(parts)))
   need(seen_selected==selected,'selected member missing')
   end=archive.offset
  # tarfile stops on the first zero header. Its buffered overread must contain
  # only padding, and the complete decoder must reach its checked footer.
  need(expanded.count>=end and expanded.count-end<=len(expanded.tail),'bounded terminal lookback')
  suffix=expanded.tail[len(expanded.tail)-(expanded.count-end):] if expanded.count>end else b''
  need(not any(suffix),'nonzero tar tail');tail_bytes=len(suffix)
  while True:
   block=expanded.read(CHUNK)
   if not block:break
   need(not any(block),'nonzero tar trailing bytes');tail_bytes+=len(block)
  need(tail_bytes>=1024 and expanded.count%512==0,'complete dual tar EOF')
  while buffered.read(CHUNK):check()
  need(raw.count==expected_bytes and raw.digest.hexdigest()==expected_sha256,'complete actual original checksum');check()
  return dict(members=rows,texts=texts,selectedTexts=selected_texts,originalBytes=raw.count,expandedBytes=expanded.count,textBytes=text_bytes)
 finally:
  if decoder is not buffered:decoder.close()
  buffered.close()
