"""Fixed installed Inngest observation. Execution stays in the existing runner."""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import struct
import time
POLICY=json.loads((Path(__file__).with_name('inngest-runtime-policy.json')).read_text())
MAXIMUM=192*1024**2

def need(value, reason):
    if not value:raise ValueError('Installed Inngest runtime: '+reason)

def additional_seconds():return len(POLICY['profiles'])*(POLICY['maximumAdditionalCommandsPerProfile']*POLICY['commandSeconds']+POLICY['originalHashPassesPerProfile']*POLICY['originalHashSeconds'])

def identity(value):
    return {name:str(getattr(value,name)) for name in ('st_dev','st_ino','st_size','st_mode','st_nlink','st_mtime_ns','st_ctime_ns')}

def snapshot(file, expected, target, check):
    file=Path(file);before=file.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=MAXIMUM and before.st_mode&0o111,'bounded actual executable required')
    for parent in file.parents:need(not parent.is_symlink(),'linked installed ancestor')
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW);digest=hashlib.sha256();total=0
    try:
        need(identity(os.fstat(fd))==identity(before),'opened executable identity changed')
        while True:
            check();block=os.read(fd,min(65536,before.st_size-total+1))
            if not block:break
            total+=len(block);need(total<=before.st_size,'executable grew');digest.update(block)
        need(total==before.st_size and digest.hexdigest()==expected,'actual executable full SHA differs')
        def read(offset,length):
            check();need(0<=offset<=before.st_size and 0<=length<=65536 and offset+length<=before.st_size,'fixed bounded executable range')
            data=os.pread(fd,length,offset);need(len(data)==length,'truncated executable header');return data
        header=read(0,min(64,before.st_size));os_name,arch=target.split('-')
        if os_name=='linux':
            need(header[:6]==b'\x7fELF\x02\x01' and struct.unpack_from('<H',header,18)[0]==(62 if arch=='x64' else 183),'ELF target differs')
            offset=struct.unpack_from('<Q',header,32)[0];size,count=struct.unpack_from('<HH',header,54);need(size==56 and 0<count<=512,'bounded ELF program table')
            interpreter,needed=False,False
            for index in range(count):
                row=read(offset+index*size,size);kind=struct.unpack_from('<I',row)[0]
                if kind==3:interpreter=True
                if kind==2:
                    start=struct.unpack_from('<Q',row,8)[0];length=struct.unpack_from('<Q',row,32)[0];need(length<=65536 and length%16==0,'bounded ELF dynamic table')
                    for at in range(0,length,16):
                        tag=struct.unpack_from('<q',read(start+at,16))[0]
                        if tag==0:break
                        if tag==1:needed=True
            need(not interpreter and not needed,'fixed CGO-disabled release unexpectedly requires ELF loader libraries')
            loader=dict(format='elf64',interpreter=False,neededLibraries=[])
        elif os_name=='darwin':
            need(header[:4]==b'\xcf\xfa\xed\xfe' and struct.unpack_from('<I',header,4)[0]==(0x01000007 if arch=='x64' else 0x0100000c),'Mach-O target differs')
            count,command_bytes=struct.unpack_from('<II',header,16);need(0<count<=512 and command_bytes<=1024**2,'bounded Mach-O commands')
            offset=32;libraries=[];minimum=None
            for _ in range(count):
                head=read(offset,8);kind,size=struct.unpack('<II',head);need(8<=size<=65536 and offset+size<=32+command_bytes,'Mach-O command bounds');row=read(offset,size)
                if kind in (0xc,0x80000018,0x8000001f,0x80000023):
                    at=struct.unpack_from('<I',row,8)[0];need(24<=at<size and b'\0' in row[at:],'Mach-O library name bounds');name=row[at:].split(b'\0',1)[0].decode('utf-8');need(name.startswith(('/usr/lib/','/System/Library/')) and not any(p in ('','.','..') for p in name.split('/')[1:]),'unresolved non-system Mach-O dependency');libraries.append(name)
                if kind in (0x24,0x32):
                    at=8 if kind==0x24 else 12;value=struct.unpack_from('<I',row,at)[0];minimum=[value>>16,(value>>8)&255,value&255]
                offset+=size
            need(offset==32+command_bytes and libraries,'complete Mach-O dependency commands required')
            loader=dict(format='macho64',libraries=libraries,minimumOS=minimum)
        else:raise ValueError('unsupported actual native host')
        need(identity(os.fstat(fd))==identity(before) and identity(file.lstat())==identity(before),'executable changed during observation')
    finally:os.close(fd)
    return dict(path=str(file),bytes=total,sha256=expected,identity=identity(before),loader=loader)

def capture(runner,runtime,cli,env,cycle,package_root,installed_package):
    target=runner.checked['target']['target'];os_name,arch=target.split('-');machine={'x86_64':'x64','amd64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine().lower())
    need(platform.system().lower()==os_name and machine==arch,'actual Python host does not match native target')
    binary=package_root/'node_modules/inngest-cli/bin/inngest';index=json.loads((package_root/'provenance/native/inngest/index.json').read_text());expected=index['binarySHA256']
    last_gate=[0.0]
    def checked_hash():
        deadline=time.monotonic()+POLICY['originalHashSeconds']
        def check():
            now=time.monotonic();need(now<deadline and (runner.deadline is None or now<runner.deadline),'actual executable hash deadline expired')
            if now-last_gate[0]>=.2:runner.gate();last_gate[0]=now
        return snapshot(binary,expected,target,check)
    before=checked_hash();native_env=dict(env,DO_NOT_TRACK='1');prefix=cli[:-1]
    runner.command(runtime+'-inngest-version',prefix+[str(binary),*POLICY['versionArguments']],native_env,cycle)
    loader_label=None
    if os_name=='darwin':
        loader_label=runtime+'-inngest-loader';runner.command(loader_label,prefix+['/usr/bin/otool','-L',str(binary)],native_env,cycle)
    after=checked_hash();need(before==after,'installed binary identity changed across actual runtime execution')
    result=dict(schemaVersion=1,kind='installed-inngest-version-runtime-originals',sourceSha=runner.plan['sourceSha'],target=target,runtime=runtime,host=dict(platform=os_name,arch=machine,release=platform.release(),macOS=platform.mac_ver()[0] if os_name=='darwin' else None),before=before,after=after,
                versionCommandLabel=runtime+'-inngest-version',loaderCommandLabel=loader_label,environment=native_env,scope='actual installed version command and observed loader metadata; no full API service or toolchain/source closure')
    file=runner.output/(runtime+'-inngest-runtime.original.json');need(not file.exists(),'fresh runtime original required');file.write_text(json.dumps(result));os.chmod(file,0o400)
    runner.result['installedVerification'][runtime]['inngestRuntimeOriginal']=dict(path=file.name,bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest());runner.save()
