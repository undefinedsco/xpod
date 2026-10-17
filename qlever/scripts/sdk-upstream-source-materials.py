"""Exact current upstream Git object closure and original patch causality.

Children inherit the configure process group. Their receipts require that
parent's independent closed-process supervision; they grant no source authority.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('upstream_budget',HERE/'sdk-execution-budget.py')
budgets=importlib.util.module_from_spec(spec);spec.loader.exec_module(budgets)
MEMBER=512*1024**2
METADATA=4*1024**2
OID=re.compile('[a-f0-9]{40}\\Z')

def write(path,value,check=lambda:None):
    size=0
    with Path(path).open('x') as output:
        for text in json.JSONEncoder(sort_keys=True,ensure_ascii=True).iterencode(value):
            check();size+=len(text)
            if size>METADATA:raise ValueError('Upstream source metadata bound')
            output.write(text)

def safe(name):
    if not isinstance(name,str) or not name or name.startswith('/') or '\\' in name or any(part in ('','.','..','.git') for part in name.split('/')):
        raise ValueError('Unsafe upstream source path')
    return name

def ref(path,root,check=lambda:None):
    path=Path(path);value=hashlib.sha256();before=path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size>MEMBER:raise ValueError('Upstream original member bound/type')
    with path.open('rb') as source:
        observed=0
        for data in iter(lambda:source.read(65536),b''):
            check();observed+=len(data)
            if observed>before.st_size:raise ValueError('Upstream original grew beyond observed bound')
            value.update(data)
        after=os.fstat(source.fileno())
    signature=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_ctime_ns,row.st_mode)
    if signature(before)!=signature(after) or signature(after)!=signature(path.lstat()):raise ValueError('Upstream original changed')
    return dict(path=path.relative_to(root).as_posix(),bytes=after.st_size,sha256=value.hexdigest())

class Collector:
    def __init__(self,source,component,out,budget):
        self.source=Path(source).resolve(strict=True);self.component=Path(component).resolve(strict=True)
        self.out=Path(out);self.out.mkdir(parents=True,exist_ok=False);self.budget=budget;self.stages=[];self.patch_steps=[]
        if (self.component/'qlever.lock.json').stat().st_size>METADATA:raise ValueError('Upstream lock metadata bound')
        self.lock=json.loads((self.component/'qlever.lock.json').read_text())
        if not OID.fullmatch(self.lock['commit']):raise ValueError('Locked SHA1 Git commit required')
    def check(self):self.budget.check(4200)
    def reference(self,path):return ref(path,self.out,self.check)
    def command(self,name,argv,maximum=METADATA,stdin=None):
        self.check();directory=self.out/'commands'/name;directory.mkdir(parents=True,exist_ok=False)
        started=time.time_ns();started_mono=time.monotonic();env=dict(os.environ,GIT_NO_LAZY_FETCH='1',GIT_TERMINAL_PROMPT='0')
        source=open(stdin,'rb') if stdin else open(os.devnull,'rb')
        child=subprocess.Popen(argv,cwd=self.source,env=env,stdin=source,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        pgid=os.getpgid(child.pid);streams={'stdout':child.stdout,'stderr':child.stderr};sizes={key:0 for key in streams}
        selector=selectors.DefaultSelector();files={key:(directory/(key+'.original')).open('xb') for key in streams}
        for key,stream in streams.items():selector.register(stream,selectors.EVENT_READ,key)
        code=None
        try:
            while selector.get_map():
                self.check()
                for event,_ in selector.select(.1):
                    key=event.data;block=os.read(event.fileobj.fileno(),65536)
                    if not block:selector.unregister(event.fileobj);continue
                    sizes[key]+=len(block)
                    if sizes[key]>(maximum if key=='stdout' else METADATA) or shutil.disk_usage(self.out).free-len(block)<2*1024**3:
                        raise ValueError('Upstream command original byte/disk bound')
                    files[key].write(block)
            code=child.wait(timeout=self.budget.timeout(30,4200))
        finally:
            source.close();selector.close()
            for stream in streams.values():stream.close()
            for stream in files.values():stream.close()
            if child.poll() is None:
                child.terminate()
                try:child.wait(timeout=2)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=2)
        receipt=dict(schemaVersion=1,argv=argv,pid=child.pid,pgid=pgid,parentPgid=os.getpgrp(),
            actualWait=True,exit=code if code is not None and code>=0 else None,signal=-code if code is not None and code<0 else None,
            startedUnixNs=str(started),endedUnixNs=str(time.time_ns()),durationSeconds=time.monotonic()-started_mono,
            scope='inherited-source-prepare-process-group; parent closed-process receipt required')
        write(directory/'receipt.json',receipt,self.check)
        row=dict(name=name,receipt=self.reference(directory/'receipt.json'),stdout=self.reference(directory/'stdout.original'),stderr=self.reference(directory/'stderr.original'))
        self.stages.append(row)
        if code!=0 or pgid!=os.getpgrp():raise ValueError('Upstream child failed or left source-prepare process group')
        return row
    def copy(self,path,name):
        self.check();path=Path(path);original=ref(path,path.parent,self.check)
        target=self.out/name;target.parent.mkdir(parents=True,exist_ok=True)
        with path.open('rb') as source,target.open('xb') as output:
            copied=0
            for block in iter(lambda:source.read(65536),b''):
                self.check();copied+=len(block)
                if copied>original['bytes']:raise ValueError('Upstream copied original grew')
                if shutil.disk_usage(self.out).free-len(block)<2*1024**3:raise ValueError('Upstream original disk bound')
                output.write(block)
        actual=self.reference(target)
        if ref(path,path.parent,self.check)!=original or (actual['bytes'],actual['sha256'])!=(original['bytes'],original['sha256']):raise ValueError('Upstream copied original changed')
        return actual
    def observe_file(self,name):
        self.check();path=self.source/safe(name);before=path.lstat()
        if stat.S_ISLNK(before.st_mode):
            data=os.fsencode(os.readlink(path));size=len(data);mode='120000'
            value=hashlib.sha256(data);blob=hashlib.sha1(b'blob '+str(size).encode()+b'\0'+data)
        elif stat.S_ISREG(before.st_mode):
            size=before.st_size
            if size>MEMBER:raise ValueError('Upstream working tree file bound')
            mode='100755' if before.st_mode&0o111 else '100644';value=hashlib.sha256();blob=hashlib.sha1(b'blob '+str(size).encode()+b'\0')
            with path.open('rb') as source:
                observed=0
                for block in iter(lambda:source.read(65536),b''):
                    self.check();observed+=len(block)
                    if observed>size:raise ValueError('Upstream working tree input grew beyond observed bound')
                    value.update(block);blob.update(block)
                after=os.fstat(source.fileno())
                if (after.st_dev,after.st_ino,after.st_size,after.st_mode,after.st_mtime_ns,after.st_ctime_ns)!=(before.st_dev,before.st_ino,before.st_size,before.st_mode,before.st_mtime_ns,before.st_ctime_ns):raise ValueError('Upstream input changed during observation')
        else:raise ValueError('Unsupported upstream working tree entry')
        after=path.lstat()
        signature=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mode,row.st_mtime_ns,row.st_ctime_ns)
        if signature(before)!=signature(after):raise ValueError('Upstream input changed during observation')
        result=dict(path=name,mode=mode,bytes=size,sha256=value.hexdigest(),blobOid=blob.hexdigest())
        if mode=='120000':
            import base64
            result['readlinkBase64']=base64.b64encode(data).decode('ascii')
        return result
    def before(self):
        head=self.command('git-head',['git','rev-parse','--verify','HEAD'])
        if (self.out/head['stdout']['path']).read_text().strip()!=self.lock['commit']:raise ValueError('Upstream actual HEAD differs from lock')
        commit=self.command('git-commit',['git','cat-file','commit',self.lock['commit']])
        data=(self.out/commit['stdout']['path']).read_bytes()
        if hashlib.sha1(b'commit '+str(len(data)).encode()+b'\0'+data).hexdigest()!=self.lock['commit']:raise ValueError('Upstream raw commit OID differs')
        root_tree=data.split(b'\n',1)[0].removeprefix(b'tree ').decode('ascii')
        if not OID.fullmatch(root_tree):raise ValueError('Upstream commit tree OID absent')
        listing=self.command('git-tree',['git','ls-tree','-r','-t','-z','--full-tree',self.lock['commit']])
        objects={self.lock['commit'],root_tree};files=[];logical=0
        for record in (self.out/listing['stdout']['path']).read_bytes().split(b'\0'):
            if not record:continue
            header,name=record.split(b'\t',1);mode,kind,oid=header.decode('ascii').split();name=safe(name.decode('utf-8'))
            if not OID.fullmatch(oid) or kind not in ('tree','blob'):raise ValueError('Unsupported Git source object kind')
            objects.add(oid)
            if kind=='tree':continue
            row=self.observe_file(name);logical+=row['bytes']
            if row['mode']!=mode or row['blobOid']!=oid:raise ValueError('Upstream actual prepatch file differs from locked Git blob/mode')
            files.append(row)
            if len(files)>100000 or logical>4*1024**3:raise ValueError('Upstream source observation count/byte bound')
        ids=self.out/'object-ids.original';id_bytes=0
        with ids.open('x') as output:
            for oid in sorted(objects):
                self.check();id_bytes+=41
                if id_bytes>METADATA:raise ValueError('Upstream Git object ID list bound')
                output.write(oid+'\n')
        sizes=self.command('git-object-sizes',['git','cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],METADATA,ids)
        expanded=0;observed=set()
        for line in (self.out/sizes['stdout']['path']).read_text().splitlines():
            oid,kind,size=line.split()
            if oid not in objects or oid in observed or kind not in ('commit','tree','blob') or not size.isdigit() or int(size)>MEMBER:raise ValueError('Upstream Git object expanded bound/type/set')
            observed.add(oid);expanded+=int(size)
            if expanded>4*1024**3:raise ValueError('Upstream Git expanded aggregate bound')
        if observed!=objects:raise ValueError('Upstream Git object size universe differs')
        pack=self.command('git-pack',['git','pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object'],MEMBER,ids)
        status=self.command('git-clean',['git','status','--porcelain','--untracked-files=all'])
        if (self.out/status['stdout']['path']).stat().st_size:raise ValueError('Upstream prepatch checkout is not clean')
        write(self.out/'prepatch-inventory.json',dict(schemaVersion=1,files=files),self.check)
        if (self.component/'patches/series').stat().st_size>METADATA:raise ValueError('Upstream patch series metadata bound')
        self.patch_series=self.copy(self.component/'patches/series','patches/series');self.patches=[]
        names=[line.strip() for line in (self.component/'patches/series').read_text().splitlines() if line.strip()]
        if len(names)!=len(set(names)):raise ValueError('Duplicate upstream patch registration')
        digest=hashlib.sha256((self.out/'patches/series').read_bytes())
        for name in names:
            safe(name);original=self.copy(self.component/'patches'/name,'patches/'+name)
            digest.update(name.encode());digest.update(b'\0')
            with (self.out/original['path']).open('rb') as stream:
                for block in iter(lambda:stream.read(65536),b''):self.check();digest.update(block)
            self.patches.append(dict(name=name,sourcePath='qlever/patches/'+name,file=original))
        if digest.hexdigest()!=self.lock['patchSeriesSha256']:raise ValueError('Upstream original patch series differs from lock')
        self.before_ended=time.time_ns()
        self.base=dict(rootTree=root_tree,objectIdsFormat='ascii-sorted-unique-sha1-lf',schemaVersion=1,kind='qlever-sdk-upstream-source-originals',repository=self.lock['repository'],commit=self.lock['commit'],objectFormat='sha1',sourceRoot=str(self.source),
            lock=self.copy(self.component/'qlever.lock.json','qlever.lock.json'),commitOriginal=commit['stdout'],treeListing=listing['stdout'],objectIds=self.reference(ids),objectPack=pack['stdout'],
            prepatchInventory=self.reference(self.out/'prepatch-inventory.json'),patchSeriesSourcePath='qlever/patches/series',patchSeries=self.patch_series,patches=self.patches)
    def patch(self,index,argv):
        item=self.patches[index];actual=self.component/'patches'/item['name']
        check='--check' in argv
        expected=['git','apply',*(['--check'] if check else []),str(actual)]
        if argv!=expected or (index,check)!=(len(self.patch_steps)//2,len(self.patch_steps)%2==0):raise ValueError('Actual patch command/series order differs')
        def unchanged():
            now=ref(actual,actual.parent,self.check)
            if any(now[key]!=item['file'][key] for key in ['bytes','sha256']):raise ValueError('Actual applied patch changed from retained original')
        unchanged();result=self.command('patch-'+str(index)+'-'+('check' if '--check' in argv else 'apply'),argv);unchanged();self.patch_steps.append((index,check));return result
    def after(self):
        if self.patch_steps!=[(index,check) for index in range(len(self.patches)) for check in [True,False]]:raise ValueError('Actual complete patch command sequence required')
        files=[];total=0
        for directory,dirs,names in os.walk(self.source,followlinks=False):
            dirs[:]=[name for name in dirs if name!='.git']
            linked=[name for name in dirs if (Path(directory)/name).is_symlink()]
            dirs[:]=[name for name in dirs if name not in linked]
            for name in [*names,*linked]:
                path=Path(directory)/name
                row=self.observe_file(path.relative_to(self.source).as_posix());files.append(row);total+=row['bytes']
                if len(files)>100000 or total>4*1024**3:raise ValueError('Upstream postpatch observation count/byte bound')
        files.sort(key=lambda row:row['path'])
        write(self.out/'postpatch-inventory.json',dict(schemaVersion=1,files=files),self.check)
        previous={row['path'] for row in json.loads((self.out/'prepatch-inventory.json').read_text())['files']}
        actual={row['path'] for row in files}
        value=dict(self.base,hookWindows=dict(beforeEndedUnixNs=str(self.before_ended),afterEndedUnixNs=str(time.time_ns())),addedPaths=sorted(actual-previous),deletedPaths=sorted(previous-actual),postpatchInventory=self.reference(self.out/'postpatch-inventory.json'),stages=self.stages,
            pending=['independent-Git-tree-patch-selected-input-and-origin-verification-required'])
        value=root_refs(value,'upstream-source')
        write(self.out/'materials.json',value,self.check)
        return value


def root_refs(value,prefix):
    if isinstance(value,list):return [root_refs(row,prefix) for row in value]
    if not isinstance(value,dict):return value
    if all(key in value for key in ['path','bytes','sha256']):return dict(value,path=prefix+'/'+safe(value['path']))
    return {key:root_refs(row,prefix) for key,row in value.items()}

def finalize(out,source,inventory,stages,check):
    out=Path(out);directory=out/'upstream-source';collection=json.loads((directory/'materials.json').read_text())
    if collection['sourceRoot']!=str(Path(source).resolve(strict=True)):raise ValueError('Upstream patch snapshot source differs from actual compiled source')
    post_ref=collection['postpatchInventory'];original=out/safe(post_ref['path'])
    if ref(original,out,check)!=post_ref:raise ValueError('Upstream postpatch inventory changed')
    post={row['path']:row for row in json.loads(original.read_text())['files']};selected=[];unresolved=[]
    for row in inventory['files']:
        check();path=Path(row['originalPath'])
        if not path.is_relative_to(source):continue
        relative=path.relative_to(source).as_posix();expected=post.get(relative)
        if expected is None:unresolved.append(dict(path=str(path),reason='selected-source-input-generated-after-patch-snapshot'));continue
        mode='100755' if row['mode']&0o111 else '100644'
        if (row['bytes'],row['sha256'],mode)!=(expected['bytes'],expected['sha256'],expected['mode']):raise ValueError('Actual selected source differs from postpatch original')
        selected.append(dict(originalPath=row['originalPath'],sourceRelativePath=relative,postpatchEntry=expected))
    write(directory/'selected-inputs.json',dict(schemaVersion=1,files=selected,unresolvedInputs=unresolved),check)
    collection['selectedInputs']=ref(directory/'selected-inputs.json',out,check)
    bindings=[stage for stage in stages if stage['name'] in ('source-prepare','configure','compile')]
    if sorted(stage['name'] for stage in bindings)!=['compile','configure','source-prepare']:raise ValueError('Actual source-prepare/configure/compile phase bindings required')
    collection['phaseBindings']={('sourcePrepare' if stage['name']=='source-prepare' else stage['name']):stage for stage in bindings}
    collection['actualInputInventory']=ref(out/'inputs-after.json',out,check)
    collection['pending']+=['selected-source-input-generated-after-patch-snapshot'] if unresolved else []
    # Preserve hook originals. The final inner collection adds actual compile input mapping.
    write(directory/'final-materials.json',collection,check)
    total=0
    for path in directory.rglob('*'):
        check()
        if path.is_file():total+=ref(path,out,check)['bytes']
    if total>4*1024**3:raise ValueError('Upstream original domain aggregate bound')
    return ref(directory/'final-materials.json',out,check),total
