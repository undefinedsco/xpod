/** Mechanical adapters only; no apt/network/official positive is claimed. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
const module='qlever/scripts/sdk-service-native-runtime-debian.py';
const worker=String.raw`
import hashlib,importlib.util,json,os,sys,tempfile,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('delta',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.path.realpath(tempfile.mkdtemp()));out=root/'out';out.mkdir()
sha=lambda b:hashlib.sha256(b).hexdigest()
# 1. Fixed ledger parsers.
src=b'libsqlite3-dev\t3.46.1-1\tsqlite3\t3.46.1-1\n'
fine=m.parse_four_column(src);assert fine['libsqlite3-dev']['source']=='sqlite3'
binraw=b'libsqlite3-dev\t3.46.1-1\tamd64\tsqlite3\t3.46.1-1\tii \n'
bins=m.parse_six_column(binraw);assert bins['libsqlite3-dev']['architecture']=='amd64'
for bad in [b'a\tb\tc\n',b'a\tb\tc\td\te\n']:
    try: m.parse_four_column(bad);raise SystemExit('bad source ledger accepted')
    except ValueError: pass
for bad in [b'a\tb\tc\td\te\n',b'a\tb\tc\td\te\tnn \n']:
    try: m.parse_six_column(bad);raise SystemExit('bad binary ledger accepted')
    except ValueError: pass
# 2. Declared package selection and ownership delta.
decl=m.select_declared(['/opt/xpod/qlever/lib/libxpod_qlever_adapter.so'],
    sources=fine,binaries=bins,ownership_name='libsqlite3-dev')
assert decl['binary']=='libsqlite3-dev' and decl['source']=='sqlite3'
owned=b'/opt/xpod/qlever/lib/libxpod_qlever_adapter.so\n/usr/lib/x86_64-linux-gnu/libsqlite3.so\n'
d=m.ownership_lines(owned,['/opt/xpod/qlever/lib/libxpod_qlever_adapter.so'])
assert d['selected']==['/opt/xpod/qlever/lib/libxpod_qlever_adapter.so']
assert d['inherited']==['/usr/lib/x86_64-linux-gnu/libsqlite3.so']
try:
    m.ownership_lines(b'/usr/lib/x86_64-linux-gnu/libsqlite3.so\n',['/opt/xpod/qlever/lib/missing.so'])
    raise SystemExit('unowned observed path accepted')
except ValueError as e: assert 'not owned' in str(e)
# 3. Shared ledger enforces ongoing tree bytes, not just after.
class Ledger:
    def __init__(self,maximum):self.maximum=maximum;self.used=0;self.reserved=0
    def check(self):pass
    def remaining(self):return self.maximum-self.used
    def reserve(self,n):
        assert n>=0
        if self.used+n>self.maximum:raise ValueError('shared reserve exceeded')
        self.used+=n
ledger=Ledger(4096);budget=m.Budget(ledger,out)
assert budget.remaining()==4096-budget.headroom
assert budget.headroom<=4096//8
big=b'x'*(budget.remaining()+1)
try:
    m._write(out,'huge.bin',big,budget=budget,ref=lambda p,r:{'path':str(p),'bytes':len(p.read_bytes()),'sha256':sha(p.read_bytes())})
    raise SystemExit('oversize write accepted')
except ValueError as e: assert 'exceed' in str(e) or 'exceeds' in str(e)
assert not (out/'huge.bin').exists()
def ref(path,root):return {'path':str(path),'bytes':path.stat().st_size,'sha256':sha(path.read_bytes())}
small=m._write(out,'small.txt',b'ok\n',budget=budget,ref=ref)
assert ref(out/'small.txt',out)['bytes']==3 and small['sha256']==sha(b'ok\n')
# 4. Stage adapter requires genuine closed receipt refs and rejects boolean JSON.
def stage_for(receipt,stdout,stderr):
    def stage(name,argv,cwd):
        return {'receipt':ref(receipt,out),'stdout':ref(stdout,out),'stderr':ref(stderr,out),'supervisionReceipt':ref(receipt.with_name('supervision.json'),out)}
    return stage
files=out/'stage';files.mkdir()
(files/'stdout.raw').write_bytes(src);(files/'stderr.raw').write_bytes(b'')
(files/'receipt.json').write_bytes(json.dumps({'actualWait':True,'signal':None,'exit':0,'pgid':17}).encode())
(files/'supervision.json').write_bytes(json.dumps({'actualWait':True,'signal':None,'exit':0,'pgid':17,'ownedGroupAbsentAfterWait':True,'resourceStop':None}).encode())
adapter=m._checked_stage(stage_for(files/'receipt.json',files/'stdout.raw',files/'stderr.raw'),out,budget)
assert adapter('x',['dpkg-query','-W'],out)['receipt']['bytes']>0
bad=json.loads((files/'receipt.json').read_bytes());bad['actualWait']=False
(files/'receipt.json').write_bytes(json.dumps(bad).encode())
try:
    adapter('x',['dpkg-query','-W'],out);raise SystemExit('open receipt accepted')
except ValueError as e: assert 'closed successful stage' in str(e)
# 5. Ref adapter binds actual bytes under out.
checked=m._checked_ref(ref,out,budget)
assert checked(out/'small.txt',out)['sha256']==sha(b'ok\n')
try:
    checked(out/'missing',out);raise SystemExit('missing ref accepted')
except (ValueError,FileNotFoundError): pass
# 6. Missing deb-src index fails closed before any collector call.
apt=root/'lists';apt.mkdir()
dpkg=root/'dpkg';dpkg.mkdir();(dpkg/'libsqlite3-dev.list').write_bytes(b'/opt/xpod/qlever/lib/libxpod_qlever_adapter.so\n')
# no source index -> expected failure
try:
    m.collect(str(out),['/opt/xpod/qlever/lib/libxpod_qlever_adapter.so'],ledger,
      stage_for(files/'receipt.json',files/'stdout.raw',files/'stderr.raw'),ref,'linux-x64',lists=apt,dpkg_info=root/'dpkg')
    raise SystemExit('missing deb-src accepted')
except ValueError as e: assert 'deb-src' in str(e)
# 7. No official positive booleans in returned shape from a failed path is not
# treated as success (collect raised above); verify constants are fixed.
assert m.NEW_PACKAGE=='libsqlite3-dev' and m.SECURITY_SUITE=='trixie-security'
assert m.HARD_LIMIT==128*1024**2
print(json.dumps({'parsers':True,'ownership':True,'budget':True,'stage':True,'ref':True,'debsrc':True,'fixed':True}))
`;
test('native Debian delta mechanics fail closed and charge ongoing tree bytes',()=>{
 const out=execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker,module],{maxBuffer:4*1024**2,timeout:45000}).toString();
 expect(JSON.parse(out)).toEqual({parsers:true,ownership:true,budget:true,stage:true,ref:true,debsrc:true,fixed:true});
},45000);
