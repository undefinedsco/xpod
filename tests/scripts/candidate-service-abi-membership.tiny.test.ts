/** Actual held file identity/maps mechanics for the membership producer. */
import{test,expect}from'bun:test';
import{execFileSync}from'node:child_process';
import fs from'node:fs';import os from'node:os';import path from'node:path';
const host='qlever/scripts/sdk-service-abi-host-session.py';
const worker=String.raw`
import hashlib,json,os,sys,types,tempfile
from pathlib import Path
module=types.ModuleType('h');module.__file='host-session.py'
exec(compile(open(sys.argv[1],'rb').read(),sys.argv[1],'exec'),module.__dict__)
class Ledger:
    def __init__(self,out):self.out=Path(out);self.refs={};self.total=0;self.out.mkdir(parents=True);self.budget=types.SimpleNamespace(check=lambda _=0:None)
    def reserve(self,n):self.total+=n;return n
    def settle(self,reserved,refs,maximum=None):
        for ref in refs:
            p=self.out/ref['path'];assert p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==ref['sha256']
            self.refs[ref['path']]=ref
def make(root,name,body):
    p=root/name.lstrip('/');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(body);return p
root=Path(tempfile.mkdtemp()).resolve();proc=root/'proc';pid=4242;base=proc/str(pid);base.mkdir(parents=True);files=root/'files'
exe='/opt/xpod/qlever/bin/xpod_qlever_local_runtime';lib='/opt/xpod/qlever/lib/libxpod_qlever_adapter.so';loader='/lib64/ld-linux-x86-64.so.2'
for name,body in [(exe,b'\x7fELF runtime'),(lib,b'\x7fELF member'),(loader,b'loader'),('/opt/xpod/qlever/share/data.txt',b'data')]:make(files,name,body)
(base/'exe').symlink_to(files/exe.lstrip('/'))
# Synthetic proc tree has no mount namespace: emulate only readlink text,
# while the new executable stat identity uses the real linked fixture file.
module._exe=lambda observed_pid,observed_root: exe
(base/'root').symlink_to(files)
def row(start,perms,path,offset=0):
    s=os.stat(str(files/path.lstrip('/')));dev=s.st_dev;major=os.major(dev);minor=os.minor(dev)
    return f'{start:012x}-{start+0x1000:012x} {perms} {offset:08x} {major:02x}:{minor:02x} {s.st_ino} {path}'
(base/'maps').write_text('\n'.join([
    row(0x7f0000000000,'r-xp',exe),
    row(0x7f0000001000,'r-xp',lib),
    row(0x7f0000002000,'r--p',lib),
    row(0x7f0000003000,'r-xp',loader),
    row(0x7f0000004000,'r--p','/opt/xpod/qlever/share/data.txt'),
    '7f0000005000-7f0000006000 rw-p 00000000 00:00 0 ',
    '7f0000009000-7f000000a000 rw-p 00000000 00:00 0 [heap]',
    '7f000000b000-7f000000c000 rw-p 00000000 00:00 0 [stack]',
])+'\n')
ledger=Ledger(root/'out')
result=module.observe_process(pid,retained=ledger,proc_root=str(proc),container={'containerId':'a'*64,'configDigest':'sha256:'+'b'*64,'imageDigest':'ghcr.io/undefinedsco/xpod@sha256:'+'c'*64})
observation=json.loads((ledger.out/result['observation']['path']).read_text())
assert observation['executableSha256']==hashlib.sha256(b'\x7fELF runtime').hexdigest()
assert observation['loaderPath']==loader and observation['inventoryComplete'] is True
assert {row['scope'] for row in observation['members']}=={'runtime-sdk','loader-or-system'}
assert observation['allFileMappings']==5 and observation['selectedMappings']==4
assert observation['ignoredDataMappings']==1 and observation['anonymousMappings']==3
assert all(claim['devMajor']>=0 and claim['devMinor']>=0 and claim['inode']>0 for row in observation['members'] for claim in row['mappings'])
assert all(row['original']['sha256']==row['sha256'] for row in observation['members'] if row['original'])
# A replaced named file must not be accepted as the maps-bound identity.
replacement=files/('loader-replacement');replacement.write_bytes(b'tampered')
files.joinpath(loader.lstrip('/')).unlink();files.joinpath(loader.lstrip('/')).symlink_to(replacement)
try:
    module.observe_process(pid,retained=Ledger(root/'out2'),proc_root=str(proc),container=observation['container'])
    raise SystemExit('tamper accepted')
except ValueError as error:
    assert 'maps device/inode' in str(error) or 'ordinary file' in str(error), error
# Missing loader mapping must fail rather than silently exclude it.
(base/'maps').write_text(row(0x7f0000000000,'r-xp',exe)+'\n7f0000009000-7f000000a000 rw-p 00000000 00:00 0 [heap]\n')
try:
    module.observe_process(pid,retained=Ledger(root/'out3'),proc_root=str(proc),container=observation['container'])
    raise SystemExit('missing loader accepted')
except ValueError as error:
    assert 'loader' in str(error), error
# A replacement between the named stat joined to maps and the held-byte reopen
# must be rejected; _read_regular and _hash_regular both take the initial identity.
target=files/loader.lstrip('/')
original_stat=os.lstat(target)
files.joinpath('loader-new').write_bytes(b'new-loader')
os.replace(files/'loader-new',target)
try:
    module._hash_regular(str(target),8*1024**2,lambda:None,module.ident(original_stat))
    raise SystemExit('stat swap accepted by hash path')
except ValueError as error:
    assert 'between named stat' in str(error),error
try:
    module._read_regular(str(target),8*1024**2,lambda:None,module.ident(original_stat))
    raise SystemExit('stat swap accepted by read path')
except ValueError as error:
    assert 'between named stat' in str(error),error
# Restore a coherent tree for the later missing-loader case.
target.write_bytes(b'loader')
# Concurrent reserve/settle must serialize and reconcile to actual retained bytes.
import threading
shared=Ledger(root/'out5')
errors=[]
def retain_one(index):
    try:
        module._retain_membership(shared,module.PREFIX+'/concurrent/'+str(index)+'.original',bytes([index])*32,64,lambda:None)
    except BaseException as error:
        errors.append(error)
threads=[threading.Thread(target=retain_one,args=(i,)) for i in range(8)]
[t.start() for t in threads];[t.join() for t in threads]
assert not errors, errors
assert len(shared.refs)==8 and shared.total==8*32, (len(shared.refs),shared.total)
assert sum(r['bytes'] for r in shared.refs.values())==shared.total
state=type('Execution',(),{'check':lambda self: (_ for _ in ()).throw(ValueError('deadline'))})()
try:
    module.observe_process(pid,retained=Ledger(root/'out4'),proc_root=str(proc),container=observation['container'],check=state.check)
    raise SystemExit('deadline accepted')
except ValueError as error:
    assert 'deadline' in str(error), error
print(json.dumps({'members':len(observation['members']),'retained':len(ledger.refs),'ok':True}))
`;
test('actual maps/file identity membership producer rejects tamper/missing loader/deadline',()=>{
 const result=JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',worker,host],{maxBuffer:8*1024**2}).toString());
 expect(result.ok).toBe(true);expect(result.members).toBe(3);
});
