import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Debian InRelease → actual Sources → exact source original digests', () => {
  it('binds plain and actual gzip/xz/bzip2 bytes, including locally recompressed lists, without asserting signature authority', () => {
    const raw = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import bz2,gzip,hashlib,importlib.util,io,json,lzma,sys,tarfile
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sha=lambda b:hashlib.sha256(b).hexdigest()
def archive(name,content):
 out=io.BytesIO()
 with tarfile.open(fileobj=out,mode='w') as tar:
  row=tarfile.TarInfo(name);row.size=len(content);tar.addfile(row,io.BytesIO(content))
 return out.getvalue()
orig=gzip.compress(archive('hello-2.10/hello.c',b'int main(void){return 0;}\n'),mtime=0)
debian=lzma.compress(archive('debian/changelog',b'hello (1:2.10-3) bookworm; urgency=medium\n'),format=lzma.FORMAT_XZ)
files=[{'path':'inner/debian-source/package-0000/hello_2.10.orig.tar.gz','bytes':len(orig),'sha256':sha(orig)}, {'path':'inner/debian-source/package-0000/hello_2.10-3.debian.tar.xz','bytes':len(debian),'sha256':sha(debian)}]
rows=''.join(' '+r['sha256']+' '+str(r['bytes'])+' '+r['path'].rsplit('/',1)[-1]+'\n' for r in files)
dsc=('Format: 3.0 (quilt)\nSource: hello\nVersion: 1:2.10-3\nChecksums-Sha256:\n'+rows).encode()
package={'name':'hello','version':'1:2.10-3','dsc':{'path':'inner/debian-source/package-0000/hello_2.10-3.dsc','bytes':len(dsc),'sha256':sha(dsc)},'files':files}
source=('Package: hello\nBinary: hello\nVersion: 1:2.10-3\nMaintainer: Debian Example <example@debian.org>\nArchitecture: any\nFormat: 3.0 (quilt)\nDirectory: pool/main/h/hello\nChecksums-Sha256:\n '+sha(dsc)+' '+str(len(dsc))+' hello_2.10-3.dsc\n'+rows+'\n').encode()
def signed(rows):
 # Armor is deliberately not a real signature: mechanics must NEVER grant it.
 return ('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: Debian\nSuite: oldstable\nCodename: bookworm\nSHA256:\n'+''.join(' '+sha(data)+' '+str(len(data))+' '+name+'\n' for name,data in rows)+'-----BEGIN PGP SIGNATURE-----\nnot-a-verified-signature\n-----END PGP SIGNATURE-----\n').encode()
def verify(release,data,packages=None,**kwargs):
 return m.verify_sources_checksum_link(release,(data[i:i+23] for i in range(0,len(data),23)),[package] if packages is None else packages,check_budget=lambda:None,**kwargs)
result=[]
for suffix,encoded in [('',source),('.gz',gzip.compress(source,mtime=0)),('.xz',lzma.compress(source)),('.bz2',bz2.compress(source))]:
 value=verify(signed([('main/source/Sources'+suffix,encoded)]),encoded)
 assert value['packages']==[{'name':'hello','version':'1:2.10-3','directory':'pool/main/h/hello'}]
 assert value['scope']=='checksum-mechanics-only-not-OpenPGP-or-keyring-authority'
 result.append(value['codec'])
 # Apt's local recompression need NOT equal the server's compressed original.
 local=gzip.compress(source,mtime=123456)
 value=verify(signed([('main/source/Sources',source),('main/source/Sources.xz',lzma.compress(source))]),local)
 assert value['signedIndexMatches']==[{'path':'main/source/Sources','form':'decoded-plain'}]
print(json.dumps({'codecs':result,'recompressedPlainBinding':True}))
`, path.resolve('qlever/scripts/sdk-debian-index-bindings.py')], {encoding: 'utf8'});
    expect(JSON.parse(raw)).toEqual({codecs: ['plain', 'gz', 'xz', 'bz2'], recompressedPlainBinding: true});
  });
  it('rejects unbound/ambiguous indexes, exact-version and digest/universe substitutions, bombs/truncation, and apt lz4 masquerading as xz', () => {
    const raw = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', String.raw`
import gzip,hashlib,importlib.util,json,sys
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
h='a'*64;dsc={'path':'tiny_1.dsc','bytes':1,'sha256':h};package={'name':'tiny','version':'1','dsc':dsc,'files':[]}
data=('Package: tiny\nVersion: 1\nDirectory: pool/main/t/tiny\nChecksums-Sha256:\n '+h+' 1 tiny_1.dsc\n\n').encode()
sha=lambda b:hashlib.sha256(b).hexdigest()
def release(rows):return ('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: Debian\nSHA256:\n'+''.join(' '+digest+' '+str(size)+' '+name+'\n' for name,digest,size in rows)+'-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n').encode()
bound=lambda b:release([('main/source/Sources',sha(b),len(b))])
def rejected(name,r,b,p=package,**kwargs):
 try:m.verify_sources_checksum_link(r,(b[i:i+7] for i in range(0,len(b),7)),[p],check_budget=lambda:None,**kwargs)
 except (ValueError,EOFError):return name
 raise AssertionError('accepted '+name)
cases=[]
cases.append(rejected('wrong signed hash',release([('main/source/Sources','0'*64,len(data))]),data))
cases.append(rejected('wrong signed size',release([('main/source/Sources',sha(data),len(data)+1)]),data))
cases.append(rejected('ambiguous component',release([('main/source/Sources',sha(data),len(data)),('contrib/source/Sources',sha(data),len(data))]),data))
cases.append(rejected('wrong exact version',bound(data),data,{**package,'version':'1+b1'}))
changed=data.replace(h.encode(),b'b'*64);cases.append(rejected('dsc digest',bound(changed),changed))
extra=data.replace(b'\n\n',b'\n '+b'c'*64+b' 2 unretained.orig.tar.gz\n\n');cases.append(rejected('missing archive',bound(extra),extra))
duplicate=data+data;cases.append(rejected('duplicate selected stanza',bound(duplicate),duplicate))
fold=data.replace(b'Version: 1',b'Version: 1\nvErSiOn: 1');cases.append(rejected('duplicate case field',bound(fold),fold))
compressed=gzip.compress(data);cases.append(rejected('gzip truncated',bound(data),compressed[:-3]))
cases.append(rejected('gzip trailing',bound(data),compressed+b'other'))
cases.append(rejected('expanded bound',bound(data),compressed,maximum_uncompressed=32))
cases.append(rejected('apt lz4 local codec',bound(data),b'\x04\x22\x4d\x18'+b'x'*32))
cases.append(rejected('signed extension spoof',release([('main/source/Sources.xz',sha(compressed),len(compressed))]),compressed))
print(json.dumps(cases))
`, path.resolve('qlever/scripts/sdk-debian-index-bindings.py')], {encoding: 'utf8'});
    expect(JSON.parse(raw)).toHaveLength(13);
  });
});
