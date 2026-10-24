"""Service profile originals from its actual Trixie image, not module defaults.

This producer records package/index/compiler originals only. Signature authority,
full source closure and ABI acceptance belong to the existing private receivers.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import stat
HERE=Path(__file__).resolve().parent

def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
profiles=load('qlever_compiler_profile');commands=load('sdk-command-materials');budgets=load('sdk-execution-budget')
LIMITS=json.loads((HERE.parents[1]/'scripts/lib/module-artifact-limits.json').read_text())

def need(value,why):
    if not value:raise ValueError('Service SDK profile: '+why)

def original_identity(value):
    return (value.st_dev,value.st_ino,value.st_mode,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_nlink)

def original(path,check,maximum,*,keep_bytes=False):
    path=Path(path);need(path.resolve(strict=True)==path and not path.is_symlink(),'canonical source original')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and 0<=before.st_size<=maximum,'bounded source original');sha=hashlib.sha256();size=0;chunks=[]
        while True:
            check();chunk=os.read(fd,min(65536,before.st_size+1-size))
            if not chunk:break
            size+=len(chunk);need(size<=before.st_size,'source original grew');sha.update(chunk)
            if keep_bytes:chunks.append(chunk)
        need(size==before.st_size and original_identity(before)==original_identity(os.fstat(fd))==original_identity(path.lstat()),'sameFD source original changed')
        reference=dict(bytes=size,sha256=sha.hexdigest())
        return (reference,b''.join(chunks)) if keep_bytes else reference
    finally:os.close(fd)

def keyring_original(path,check,maximum):
    """Only Debian's fixed .gpg -> .pgp transition, never generic symlink input.

    This is actual alias/byte provenance only. Candidate keyring contents do not
    establish signature authority, which remains the independent controller's.
    """
    path=Path(path);check();need(path.is_absolute() and path.name=='debian-archive-keyring.gpg','fixed Debian keyring original')
    parent=path.parent;need(parent.resolve(strict=True)==parent and not parent.is_symlink(),'canonical Debian keyring directory')
    directory=parent.lstat();alias=path.lstat();target=path;link=None
    if stat.S_ISLNK(alias.st_mode):
        link=os.readlink(path);need(link=='debian-archive-keyring.pgp','fixed same-directory Debian keyring alias')
        target=parent/link
    else:need(stat.S_ISREG(alias.st_mode),'regular Debian keyring or fixed alias required')
    before=target.lstat();reference=original(target,check,maximum)
    need(original_identity(before)==original_identity(target.lstat()) and original_identity(alias)==original_identity(path.lstat()) and original_identity(directory)==original_identity(parent.lstat()),'Debian keyring alias/target identity changed')
    if link is not None:need(os.readlink(path)==link,'Debian keyring readlink changed')
    return dict(path=str(path),canonicalPath=str(target),**reference,identityDecimal=[str(value) for value in original_identity(before)],alias=dict(kind='symlink' if link is not None else 'regular',readlink=link,identityDecimal=[str(value) for value in original_identity(alias)]),directoryIdentityDecimal=[str(value) for value in original_identity(directory)])

def capture_keyring_gpgv(label,snapshot,index,materials,root,check,timeout):
    keyring=Path(snapshot['path'])
    need(keyring_original(keyring,check,LIMITS['metadataBytes'])==snapshot,'Debian keyring changed before actual gpgv')
    row=commands.capture_gpgv(label,keyring,index,materials,root,timeout=timeout)
    need(keyring_original(keyring,check,LIMITS['metadataBytes'])==snapshot,'Debian keyring changed after actual gpgv')
    return row

def validate_interior(profile,release,machine,compiler_outputs):
    need(profile['name']=='service-trixie' and release.get('ID','').strip('"')=='debian' and release.get('VERSION_CODENAME','').strip('"')==profile['distribution'],'actual declared service distribution required')
    need(machine in ['x86_64','aarch64'],'actual supported native service host')
    prefix='Debian clang version '+str(profile['compiler_major'])+'.'
    need(compiler_outputs['c'].startswith(prefix) and compiler_outputs['cxx'].startswith(prefix),'actual declared service compiler major required')
    need(compiler_outputs['linker'].startswith('Debian LLD '+str(profile['compiler_major'])+'.'),'actual declared service linker required')

def capture():
    profile=profiles.declared_profile('service-trixie');identity=json.loads(os.environ['XPOD_QLEVER_SDK_IDENTITY'])
    need(identity.get('sdkProfile')==profile['name'] and profiles.compiler_spec()['profile']==profile['name'],'same actual SDK/compiler profile')
    budget=budgets.ExecutionBudget(float(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX']));check=lambda:budget.check(4200)
    root=HERE.parent;destination=Path('/opt/qlever-sdk/profile');destination.mkdir(parents=True,exist_ok=True);materials=Path('/opt/qlever-sdk/materials');stages=[]
    def command(label,argv):
        row=commands.capture(label,argv,materials,root,timeout=budget.timeout(30,4200));stages.append(row);path=materials/row['stdout']['path'];reference,data=original(path,check,65536,keep_bytes=True);need(reference=={key:row['stdout'][key] for key in ['bytes','sha256']},'actual closed tool output differs');return data.decode()
    outputs={role:command('service-profile-'+role,[profile[role] if role in ['c','cxx'] else profile['linker_program'],'--version']).splitlines()[0] for role in ['c','cxx','linker']}
    _,release_bytes=original(Path('/etc/os-release').resolve(strict=True),check,65536,keep_bytes=True)
    release=dict(line.split('=',1) for line in release_bytes.decode().splitlines() if '=' in line)
    validate_interior(profile,release,platform.machine(),outputs)
    base=os.environ.get('XPOD_QLEVER_SDK_BASE_IMAGE','');need('@sha256:' in base,'actual immutable service base image required')
    signed=[];keyring=Path('/usr/share/keyrings/debian-archive-keyring.gpg');keyring_snapshot=keyring_original(keyring,check,LIMITS['metadataBytes']);indices=sorted(Path('/var/lib/apt/lists').glob('*InRelease'));need(indices,'retained actual service release indexes absent')
    for index in indices:
        check();raw=original(index,check,LIMITS['metadataBytes']);row=capture_keyring_gpgv('service-profile-debian-index-'+str(len(signed)),keyring_snapshot,index,materials,root,check,budget.timeout(30,4200));copy=destination/'apt'/index.name;copy.parent.mkdir(exist_ok=True);shutil.copyfile(index,copy);need(original(copy,check,LIMITS['metadataBytes'])==raw,'retained service index changed');signed.append(dict(path='apt/'+index.name,**raw,verificationStage=row))
    packages={path.name:original(path,check,LIMITS['shardBytes'])['sha256'] for path in sorted(Path('/var/lib/apt/lists').glob('*Packages*')) if path.is_file()};need(packages,'retained actual package indexes absent')
    ledger=command('service-profile-package-ledger',['dpkg-query','-W','-f=${binary:Package}\t${Version}\t${Architecture}\n']);ledger_path=destination/'dpkg-packages.txt';ledger_path.write_text(ledger)
    compiler_files={role:dict(path=str(Path(shutil.which(profile[role] if role in ['c','cxx'] else profile['linker_program'])).resolve(strict=True)),**original(Path(shutil.which(profile[role] if role in ['c','cxx'] else profile['linker_program'])).resolve(strict=True),check,LIMITS['shardBytes'])) for role in ['c','cxx','linker']}
    need(keyring_original(keyring,check,LIMITS['metadataBytes'])==keyring_snapshot,'Debian keyring changed before profile seal')
    payload=dict(schemaVersion=1,profile=profile['name'],baseImage=base,machine=platform.machine(),glibc=command('service-profile-glibc',['getconf','GNU_LIBC_VERSION']).strip(),compilerVersions=outputs,compilerFiles=compiler_files,packageLedgerSha256=original(ledger_path,check,LIMITS['metadataBytes'])['sha256'],keyringSha256=keyring_snapshot['sha256'],keyringOriginals=keyring_snapshot,signedReleaseOriginals=signed,packageIndexHashes=packages,stages=stages,dockerfileSha256=original(destination/'Dockerfile',check,LIMITS['metadataBytes'])['sha256'],runtimeDockerfileSha256=original(destination/'runtime.Dockerfile',check,LIMITS['metadataBytes'])['sha256'],lockSha256=original(root/'qlever.lock.json',check,LIMITS['metadataBytes'])['sha256'],scope='Actual service compiler/package/index originals; no source/signature/ABI authority')
    data=(json.dumps(payload,sort_keys=True,indent=2)+'\n').encode();need(len(data)<=LIMITS['metadataBytes'],'bounded service profile metadata before open');check()
    with (destination/'inputs.json').open('xb') as target:target.write(data);target.flush();os.fsync(target.fileno())
    return payload

if __name__=='__main__':capture()
