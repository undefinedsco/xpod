"""Actual stopped-tracee provider snapshots; no source authority or new tracer.

The caller must hold its existing complete all-task barrier and retained tool FD.
A read-only provider is a fact at this stop, not proof against future remounts or
an assertion of immutable tool source/complete loader coverage.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import stat

_spec=importlib.util.spec_from_file_location('provider_util',Path(__file__).with_name('sdk-execution-originals-util.py'));util=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(util)
class ProviderUnavailable(ValueError):pass

def need(condition,reason):
    if not condition:raise ValueError('tool provider originals: '+reason)
def canonical(path):return isinstance(path,str) and path.startswith('/') and os.path.normpath(path)==path and not path.endswith(' (deleted)') and '\x00' not in path

def identity(value):
    need(isinstance(value,list) and len(value)==6 and all(type(item) is int and item>=0 for item in value),'exact six-field kernel identity required');return value

def provider_for(path,mountinfo,file_identity,mount_id):
    """Use actual tracee namespace mountinfo, never the controller mount table."""
    need(canonical(path),'canonical actual named tool path required');identity(file_identity)
    try:provider=util.effective_readonly(path,mountinfo,resolve_local=False)
    except AssertionError as error:raise ProviderUnavailable(str(error)) from error
    matching=[]
    for line in mountinfo.decode('utf-8','strict').splitlines():
        fields=line.split();separator=fields.index('-');need(separator>=6 and len(fields)>separator+3,'mountinfo layout')
        mount=fields[4].replace('\\040',' ').replace('\\011','\t').replace('\\012','\n').replace('\\134','\\')
        if mount==provider['mount']:matching.append(fields)
    if len(matching)!=1:raise ProviderUnavailable('ambiguous stacked tool provider mount')
    need(type(mount_id) is int and mount_id>0,'actual FD mount identity required')
    if int(matching[0][0])!=mount_id:raise ProviderUnavailable('actual held FD mount differs from named read-only provider')
    major,minor=matching[0][2].split(':');need(major.isdigit() and minor.isdigit(),'mount device format')
    if (int(major),int(minor))!=(os.major(file_identity[0]),os.minor(file_identity[0])):raise ProviderUnavailable('actual named tool FD/provider device differs')
    return dict(provider,mountId=mount_id)

def bounded_mountinfo(pid,check,maximum):
    data=bytearray()
    with open('/proc/'+str(pid)+'/mountinfo','rb') as source:
        while True:
            check();block=source.read(min(65536,maximum+1-len(data)))
            if not block:break
            data.extend(block);need(len(data)<=maximum,'actual mountinfo metadata bound')
    return bytes(data)

def fd_mount_id(raw,file_identity):
    need(isinstance(raw,str) and len(raw.encode())<=4096,'bounded actual fdinfo required')
    values={}
    for line in raw.splitlines():
        key,_,value=line.partition(':')
        if key in ['mnt_id','ino']:
            need(key not in values and value.strip().isdigit(),'unique kernel FD mount/inode field required');values[key]=int(value.strip())
    need(set(values)=={'mnt_id','ino'} and values['mnt_id']>0 and values['ino']==file_identity[1],'actual FD mount/inode differs');return values['mnt_id']

def fdinfo(fd,check):
    check()
    with open('/proc/self/fdinfo/'+str(fd),'rb') as source:data=source.read(4097)
    need(len(data)<=4096,'actual FD metadata bound');return data.decode('utf-8','strict')

def capture_provider(pid,reader,actual_path,expected_identity,check,maximum_metadata):
    """Caller writes returned bytes through its one charged capture ledger."""
    need(type(pid) is int and pid>0 and type(maximum_metadata) is int and maximum_metadata>0,'bounded actual tracee required');identity(expected_identity)
    if not canonical(actual_path):raise ProviderUnavailable('actual named tool path unavailable')
    prefix='/proc/'+str(pid);namespace=root=named=None
    try:
        check();namespace=os.open(prefix+'/ns/mnt',os.O_RDONLY|os.O_CLOEXEC);root=os.open(prefix+'/root',os.O_PATH|os.O_DIRECTORY|os.O_CLOEXEC)
        namespace_name=os.readlink(prefix+'/ns/mnt');namespace_identity=util.identity(os.fstat(namespace));root_identity=util.identity(os.fstat(root))
        need(re.fullmatch(r'mnt:\[[0-9]+\]',namespace_name),'actual mount namespace format')
        named=os.open(actual_path.lstrip('/'),os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=root)
        if util.identity(os.fstat(named))!=expected_identity or util.identity(os.fstat(reader))!=expected_identity:raise ProviderUnavailable('actual tracee named path/held tool FD identity differs')
        held_info=fdinfo(reader,check);named_info=fdinfo(named,check);held_mount=fd_mount_id(held_info,expected_identity);named_mount=fd_mount_id(named_info,expected_identity)
        if held_mount!=named_mount:raise ProviderUnavailable('actual held/named FD mount differs')
        data=bounded_mountinfo(pid,check,maximum_metadata);provider=provider_for(actual_path,data,expected_identity,held_mount)
        # A fresh complete reread prevents registering mixed mount-table snapshots.
        if fdinfo(reader,check)!=held_info or fdinfo(named,check)!=named_info or bounded_mountinfo(pid,check,maximum_metadata)!=data:raise ProviderUnavailable('tracee mount table changed during provider capture')
        if (os.readlink(prefix+'/ns/mnt')!=namespace_name or util.identity(os.stat(prefix+'/ns/mnt'))!=namespace_identity or util.identity(os.fstat(namespace))!=namespace_identity or util.identity(os.stat(prefix+'/root'))!=root_identity or util.identity(os.fstat(root))!=root_identity or util.identity(os.fstat(named))!=expected_identity or util.identity(os.fstat(reader))!=expected_identity):raise ProviderUnavailable('tracee namespace/root/tool identity changed during provider capture')
        check();return data,dict(schemaVersion=1,kind='actual-stopped-tracee-tool-provider',pid=pid,actualPath=actual_path,identity=list(expected_identity),mountNamespace=namespace_name,mountNamespaceIdentity=namespace_identity,rootIdentity=root_identity,heldFdinfoRaw=held_info,namedFdinfoRaw=named_info,provider=provider)
    except OSError as error:
        if error.errno not in [1,2,3,13,20,40]:raise
        raise ProviderUnavailable('tracee tool provider unavailable errno='+str(error.errno)) from error
    finally:
        for fd in [named,root,namespace]:
            if fd is not None:os.close(fd)

def verify_provider_originals(record,mountinfo,*,pid,actual_path,file_identity):
    """Pure parser invoked only after actual all-stop/raw/FD/ref verification."""
    need(record.get('schemaVersion')==1 and record.get('kind')=='actual-stopped-tracee-tool-provider' and record.get('pid')==pid and record.get('actualPath')==actual_path and record.get('identity')==file_identity,'actual tool provider role/FD binding differs')
    namespace_identity=identity(record.get('mountNamespaceIdentity'));root_identity=identity(record.get('rootIdentity'));need(stat.S_ISDIR(root_identity[2]),'actual tracee root directory required');match=re.fullmatch(r'mnt:\[([0-9]+)\]',record.get('mountNamespace',''));need(match is not None and int(match.group(1))==namespace_identity[1],'actual namespace binding required')
    ref=record['mountinfoOriginal'];need(type(ref.get('bytes')) is int and len(mountinfo)==ref['bytes'] and hashlib.sha256(mountinfo).hexdigest()==ref.get('sha256'),'actual mountinfo original bytes differ')
    held_mount=fd_mount_id(record.get('heldFdinfoRaw'),file_identity);need(held_mount==fd_mount_id(record.get('namedFdinfoRaw'),file_identity),'actual named/held FD mounts differ')
    provider=provider_for(actual_path,mountinfo,file_identity,held_mount);need(record.get('provider')==provider,'actual effective read-only provider projection differs')
    return dict(scope='actual stopped tracee namespace named-FD effective read-only provider only',provider=provider,mountNamespace=record['mountNamespace'],identityDecimal=[str(value) for value in file_identity],mountNamespaceIdentityDecimal=[str(value) for value in record['mountNamespaceIdentity']],rootIdentityDecimal=[str(value) for value in record['rootIdentity']],mountinfoOriginal=ref)
