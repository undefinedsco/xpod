"""Fixed installed Inngest observation. Execution stays in the existing runner."""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import struct
import time
import socket
import signal
import http.client
import secrets
import threading
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

def listener_owner(port, members, check, proc=Path('/proc')):
    """Actual Linux socket inode must belong to this observed process group."""
    check();inodes=set()
    with (proc/'net/tcp').open('rb') as table:raw=table.read(4*1024**2+1)
    need(len(raw)<=4*1024**2,'bounded TCP listener table')
    for line in raw.decode('ascii').splitlines()[1:]:
        fields=line.split()
        if len(fields)>=10 and fields[1]=='0100007F:%04X'%port and fields[3]=='0A':inodes.add(fields[9])
    need(len(inodes)==1,'unique actual loopback listener required');inode=next(iter(inodes));owners=[]
    need(0<len(members)<=4096,'bounded observed process group required')
    for pid in members:
        check()
        try:
            directory=proc/str(pid)/'fd';matched=False;count=0
            with os.scandir(directory) as descriptors:
                for entry in descriptors:
                    count+=1;need(count<=65536,'bounded process descriptors');check()
                    if os.readlink(entry.path)=='socket:['+inode+']':matched=True
            if matched:owners.append(int(pid))
        except FileNotFoundError:continue
    need(len(owners)==1,'listener is not uniquely owned by actual probe group')
    return dict(pid=owners[0],inode=inode,port=port)

def bounded_http_request(port,method,path,body,end,check):
    """SIGALRM bounds all header/body parsing, including socket drip feeds.

    This driver runs on the runner main thread. Never replace somebody else's
    active timer: an unsupported caller context fails closed before networking.
    """
    check();need(threading.current_thread() is threading.main_thread(),'HTTP deadline requires main thread')
    need(signal.getitimer(signal.ITIMER_REAL)==(0.0,0.0),'HTTP deadline cannot replace an active timer')
    remaining=end-time.monotonic();need(remaining>0,'installed protocol deadline expired')
    previous=signal.getsignal(signal.SIGALRM)
    def expired(_signal,_frame):raise ValueError('Installed Inngest runtime: absolute HTTP deadline expired')
    connection=None
    try:
        signal.signal(signal.SIGALRM,expired)
        signal.setitimer(signal.ITIMER_REAL,remaining)
        connection=http.client.HTTPConnection('127.0.0.1',port,timeout=min(1,remaining))
        connection.request(method,path,body=body,headers={'Content-Type':'application/json'})
        response=connection.getresponse();raw=response.read(16385)
        check();need(len(raw)<=16384,'bounded protocol response');need(response.status==200,'actual protocol HTTP status differs')
        value=json.loads(raw)
        return value,dict(method=method,path=path,status=response.status,body=raw.decode('utf-8'))
    finally:
        # Cancel before restoring the handler; the original timer was inactive.
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,previous)
        if connection is not None:connection.close()

def protocol(runner,runtime,prefix,binary,env,cycle):
    # One pre-existing command slot; no additional deadline/window is created.
    end=min(time.monotonic()+POLICY['commandSeconds'],runner.deadline or float('inf'))
    last_gate=[float('-inf')]
    def check():
        now=time.monotonic();need(now<end,'installed protocol deadline expired')
        if now-last_gate[0]>=.2:runner.gate();last_gate[0]=now
    check();sockets=[]
    try:
        for _ in range(4):
            sock=socket.socket();sock.bind(('127.0.0.1',0));sockets.append(sock)
        ports=[s.getsockname()[1] for s in sockets];need(len(set(ports))==4 and 60895 not in ports,'distinct owned probe ports required')
    finally:
        for sock in sockets:sock.close()
    argv=[str(binary),'dev','--no-discovery','--no-poll','--host','127.0.0.1','--port',str(ports[0]),'--connect-gateway-port',str(ports[1]),'--connect-gateway-grpc-port',str(ports[2]),'--connect-executor-grpc-port',str(ports[3])]
    requests=[];proof={}
    def request(method,path,body=None):
        value,original=bounded_http_request(ports[0],method,path,body,end,check)
        requests.append(original);return value
    def exercise(process):
        while True:
            check();need(process.poll() is None,'probe exited before readiness');members=runner.observe_group(process)
            try:
                owner=listener_owner(ports[0],members,check);health=request('GET','/health')
                break
            except (OSError,http.client.HTTPException):time.sleep(.05)
            except ValueError as error:
                if 'unique actual loopback listener required' not in str(error):raise
                time.sleep(.05)
        need(health=={'status':200,'message':'OK'},'fixed health response differs')
        nonce=secrets.token_hex(16);event={'name':'xpod/module-native-probe','id':nonce,'data':{'nonce':nonce}}
        accepted=request('POST','/e/xpod-module-probe',json.dumps(event,separators=(',',':')).encode())
        need(set(accepted)=={'ids','status'} and accepted['status']==200 and isinstance(accepted['ids'],list) and len(accepted['ids'])==1 and isinstance(accepted['ids'][0],str) and 0<len(accepted['ids'][0])<=128,'actual event acceptance response differs')
        need(listener_owner(ports[0],runner.observe_group(process),check)==owner and process.poll() is None,'owned listener changed across communication')
        proof.update(commandLabel=runtime+'-inngest-protocol',ports=ports,owner=owner,requests=requests,event=event)
        # Signal only the listener already bound to this exact observed group.
        check();need(listener_owner(ports[0],runner.observe_group(process),check)==owner,'listener changed before shutdown')
        os.kill(owner['pid'],signal.SIGTERM)
        process.wait(timeout=max(.001,end-time.monotonic()));need(process.returncode==0,'native protocol did not close with actual exit 0')
    runner.command(runtime+'-inngest-protocol',prefix+argv,env,cycle,exercise)
    return proof

def bounded_json(file,maximum=65536):
    file=Path(file);before=file.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=maximum,'bounded regular JSON original');fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        need(identity(os.fstat(fd))==identity(before),'JSON original descriptor changed');parts=[];count=0
        while True:
            chunk=os.read(fd,min(65536,before.st_size-count+1))
            if not chunk:break
            count+=len(chunk);need(count<=before.st_size,'JSON original grew');parts.append(chunk)
        need(count==before.st_size and identity(os.fstat(fd))==identity(before) and identity(file.lstat())==identity(before),'JSON original changed')
        return json.loads(b''.join(parts))
    finally:os.close(fd)

def controlled_policy_file():
    return Path(__file__).resolve().parents[2]/'packages/xpod-api/scripts/inngest-controlled-build-policy.json'

def installed_binary_expectation(index,target):
    """Strict byte selector only; installed files and private issuer decide trust."""
    need(isinstance(index,dict),'native index object required')
    if index.get('schemaVersion')==1:
        need(target==str(index.get('platform'))+'-'+str(index.get('arch')),'official index target differs')
        expected=index.get('binarySHA256');size=None
    elif index.get('schemaVersion')==2:
        controlled=bounded_json(controlled_policy_file())
        need(index.get('sourceKind')==controlled['sourceKind'] and target in controlled['targets'] and index.get('target')==target and index.get('sourceCommit')==controlled['sourceCommit'],'controlled index selector differs')
        binary=index.get('binary');need(isinstance(binary,dict) and binary.get('path')=='node_modules/inngest-cli/bin/inngest','fixed controlled installed path')
        expected=binary.get('sha256');size=binary.get('bytes');need(type(size) is int and 0<size<=MAXIMUM,'bounded controlled binary size')
    else:raise ValueError('Installed Inngest runtime: unsupported native index schema')
    need(isinstance(expected,str) and len(expected)==64 and all(c in '0123456789abcdef' for c in expected),'fixed native binary SHA required')
    return expected,size

def capture(runner,runtime,cli,env,cycle,package_root,installed_package):
    target=runner.checked['target']['target'];os_name,arch=target.split('-');machine={'x86_64':'x64','amd64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine().lower())
    need(platform.system().lower()==os_name and machine==arch,'actual Python host does not match native target')
    binary=package_root/'node_modules/inngest-cli/bin/inngest';index=bounded_json(package_root/'provenance/native/inngest/index.json');expected,expected_size=installed_binary_expectation(index,target)
    last_gate=[0.0]
    def checked_hash():
        deadline=time.monotonic()+POLICY['originalHashSeconds']
        def check():
            now=time.monotonic();need(now<deadline and (runner.deadline is None or now<runner.deadline),'actual executable hash deadline expired')
            if now-last_gate[0]>=.2:runner.gate();last_gate[0]=now
        value=snapshot(binary,expected,target,check);need(expected_size is None or value['bytes']==expected_size,'controlled installed size differs');return value
    before=checked_hash();native_env=dict(env,DO_NOT_TRACK='1');prefix=cli[:-1]
    runner.command(runtime+'-inngest-version',prefix+[str(binary),*POLICY['versionArguments']],native_env,cycle)
    loader_label=None;protocol_original=None
    if os_name=='linux':protocol_original=protocol(runner,runtime,prefix,binary,native_env,cycle)
    if os_name=='darwin':
        loader_label=runtime+'-inngest-loader';runner.command(loader_label,prefix+['/usr/bin/otool','-L',str(binary)],native_env,cycle)
    after=checked_hash();need(before==after,'installed binary identity changed across actual runtime execution')
    result=dict(schemaVersion=1,kind='installed-inngest-version-runtime-originals',sourceSha=runner.plan['sourceSha'],target=target,runtime=runtime,host=dict(platform=os_name,arch=machine,release=platform.release(),macOS=platform.mac_ver()[0] if os_name=='darwin' else None),before=before,after=after,
                versionCommandLabel=runtime+'-inngest-version',loaderCommandLabel=loader_label,protocol=protocol_original,environment=native_env,scope='actual installed version command and observed loader metadata; no full API service or toolchain/source closure')
    file=runner.output/(runtime+'-inngest-runtime.original.json');need(not file.exists(),'fresh runtime original required');file.write_text(json.dumps(result));os.chmod(file,0o400)
    runner.result['installedVerification'][runtime]['inngestRuntimeOriginal']=dict(path=file.name,bytes=file.stat().st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest());runner.save()
