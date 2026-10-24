import bz2,gzip,hashlib,importlib.util,io,lzma,tarfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('reader',Path(__file__).resolve().parents[1]/'scripts/sdk-service-native-license-archive.py');reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
def archive(names=('pkg/LICENSE','pkg/source.c')):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w')as tar:
  for name in names:
   item=tarfile.TarInfo(name);item.size=3;tar.addfile(item,io.BytesIO(b'abc'))
 return out.getvalue()
class Tests(unittest.TestCase):
 def run_reader(self,raw,**kwargs):
  self.charged=0;requests=[]
  class Stream(io.BytesIO):
   def read(self,n=-1):requests.append(n);self.assert_request(n);return super().read(n)
   def assert_request(self,n):assert 0<=n<=65536
  def charge(n):self.charged+=n
  args=dict(check=lambda:None,charge_read=charge,charge_expanded=lambda n:None,maximum_expanded_bytes=100000,maximum_text_bytes=1000);args.update(kwargs)
  result=reader.inspect_archive(Stream(raw),len(raw),hashlib.sha256(raw).hexdigest(),**args);self.assertEqual(self.charged,len(raw));self.assertTrue(requests);return result
 def test_real_four_formats(self):
  for encode in (lambda x:x,gzip.compress,lzma.compress,bz2.compress):
   with self.subTest(encode=encode):
    result=self.run_reader(encode(archive()));self.assertEqual(len(result['members']),2);self.assertEqual(result['texts'][0]['text'],b'abc');self.assertEqual(result['textBytes'],3)
 def test_compressed_trailers_and_truncation(self):
  for encode in (gzip.compress,lzma.compress,bz2.compress):
   raw=encode(archive())
   for bad in (raw[:-4],raw+b'garbage'):
    with self.subTest(encode=encode,badlen=len(bad)),self.assertRaises((ValueError,EOFError,OSError)):self.run_reader(bad)
 def test_tar_tail_and_missing_dual_eof(self):
  raw=archive()
  for bad in (raw[:2048]+b'X'+raw[2049:],raw[:2560]):
   with self.assertRaises((ValueError,tarfile.TarError)):self.run_reader(bad)
 def test_canonical_unique_names(self):
  for names in (('pkg/LICENSE','pkg/LICENSE'),('../escape',),('/absolute',)):
   with self.assertRaises(ValueError):self.run_reader(archive(names))
 def test_cumulative_limits(self):
  with self.assertRaisesRegex(ValueError,'expanded ceiling'):self.run_reader(gzip.compress(archive()),maximum_expanded_bytes=1024)
  with self.assertRaisesRegex(ValueError,'notice text ceiling'):self.run_reader(archive(('pkg/LICENSE','pkg/NOTICE')),maximum_text_bytes=5)
 def test_parent_exception_identity(self):
  stop=RuntimeError('shared parent');calls=[0]
  def check():
   calls[0]+=1
   if calls[0]==6:raise stop
  try:self.run_reader(gzip.compress(archive()),check=check)
  except RuntimeError as error:self.assertIs(error,stop)
  else:self.fail('parent ignored')
 def test_actual_checksum(self):
  raw=archive()
  with self.assertRaisesRegex(ValueError,'checksum'):reader.inspect_archive(io.BytesIO(raw),len(raw),'0'*64,check=lambda:None,charge_read=lambda n:None,charge_expanded=lambda n:None,maximum_expanded_bytes=100000,maximum_text_bytes=1000)
 def test_sparse_rejected_in_all_formats_before_logical_holes(self):
  # Both formats encode one physical byte but imply a one MiB logical file.
  item=tarfile.TarInfo('pkg/sparse');item.type=tarfile.GNUTYPE_SPARSE;item.size=1
  header=bytearray(item.tobuf(format=tarfile.GNU_FORMAT))
  header[386:398]=tarfile.itn(0,12);header[398:410]=tarfile.itn(1,12);header[483:495]=tarfile.itn(1024**2,12)
  header[148:156]=b' '*8;header[148:156]=('%06o\0 '%sum(header)).encode()
  gnu=bytes(header)+b'x'+b'\0'*511+b'\0'*1024
  output=io.BytesIO()
  with tarfile.open(fileobj=output,mode='w',format=tarfile.PAX_FORMAT)as tar:
   item=tarfile.TarInfo('pkg/sparse');item.size=1;item.pax_headers={'GNU.sparse.map':'0,1','GNU.sparse.size':str(1024**2)};tar.addfile(item,io.BytesIO(b'x'))
  for raw in (gnu,output.getvalue()):
   with tarfile.open(fileobj=io.BytesIO(raw),mode='r:')as tar:self.assertIsNotNone(tar.next().sparse)
   for encode in (lambda x:x,gzip.compress,lzma.compress,bz2.compress):
    with self.subTest(rawlen=len(raw),encode=encode),self.assertRaisesRegex(ValueError,'sparse source member unsupported'):
     self.run_reader(encode(raw),maximum_expanded_bytes=12000)
 def test_selected_exact_bytes_and_sha(self):
  raw=archive(('pkg/LICENSE','pkg/source.c'))
  for encode in (lambda x:x,gzip.compress,lzma.compress,bz2.compress):
   with self.subTest(encode=encode):
    result=self.run_reader(encode(raw),selected_members=('pkg/LICENSE','pkg/source.c'))
    self.assertEqual([(row['path'],row['bytes'],row['sha256'],row['text'])for row in result['selectedTexts']],[('pkg/LICENSE',3,hashlib.sha256(b'abc').hexdigest(),b'abc'),('pkg/source.c',3,hashlib.sha256(b'abc').hexdigest(),b'abc')])
    self.assertEqual(result['textBytes'],6)
 def test_selected_notice_charged_once(self):
  result=self.run_reader(archive(),selected_members=('pkg/LICENSE',))
  self.assertEqual(len(result['texts']),1);self.assertEqual(len(result['selectedTexts']),1);self.assertEqual(result['textBytes'],3)
  with self.assertRaisesRegex(ValueError,'notice text ceiling'):self.run_reader(archive(),selected_members=('pkg/LICENSE','pkg/source.c'),maximum_text_bytes=5)
 def test_selected_missing_or_nonregular(self):
  with self.assertRaisesRegex(ValueError,'selected member'):self.run_reader(archive(),selected_members=('pkg/LICENSE','pkg/missing.c'))
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w')as tar:
   item=tarfile.TarInfo('pkg/dir');item.type=tarfile.DIRTYPE;tar.addfile(item)
   item=tarfile.TarInfo('pkg/link');item.type=tarfile.SYMTYPE;item.linkname='source.c';tar.addfile(item)
  for name in ('pkg/dir','pkg/link'):
   with self.assertRaisesRegex(ValueError,'selected member not regular'):self.run_reader(out.getvalue(),selected_members=(name,))
 def test_selected_duplicate_and_noncanonical_rejected(self):
  raw=archive()
  for requested in (('pkg/LICENSE','pkg/LICENSE'),('../escape',),('/absolute',),('a\\b',),('a//b',),('a/./b',)):
   with self.subTest(requested=requested),self.assertRaisesRegex(ValueError,'canonical unique selected member'):self.run_reader(raw,selected_members=requested)
 def test_selected_large_member_exact_bytes(self):
  payload=bytes(range(256))*274
  out=io.BytesIO()
  with tarfile.open(fileobj=out,mode='w')as tar:
   item=tarfile.TarInfo('pkg/source.c');item.size=len(payload);tar.addfile(item,io.BytesIO(payload))
  result=self.run_reader(gzip.compress(out.getvalue()),selected_members=('pkg/source.c',),maximum_text_bytes=len(payload))
  self.assertEqual(result['selectedTexts'],[dict(path='pkg/source.c',bytes=len(payload),sha256=hashlib.sha256(payload).hexdigest(),text=payload)])
 def test_selected_default_empty(self):
  self.assertEqual(self.run_reader(archive())['selectedTexts'],[])
if __name__=='__main__':unittest.main()
