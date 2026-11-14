"""Producer wiring only; binary parsing and signature policy belong to Legal."""
import hashlib
import importlib.util
import os
from pathlib import Path
import stat

HERE=Path(__file__).resolve().parent
INFO_ROOT=Path('/var/lib/dpkg/info')
METADATA=4*1024**2
OWNERSHIP_LIMIT=16*1024**2

def preserve_ownership(out,paths,remaining,ref,check):
    out=Path(out);destination=out/'ownership-originals';destination.mkdir()
    rows=[];used=0
    for source in sorted(set(Path(path) for path in paths)):
        check()
        if source.parent!=INFO_ROOT or not source.name.endswith('.list'):raise ValueError('Actual dpkg ownership original path required')
        before=source.lstat();size=before.st_size
        if not stat.S_ISREG(before.st_mode) or size>METADATA or used+size>OWNERSHIP_LIMIT or size>remaining():raise ValueError('Ownership original byte/type budget')
        identity=lambda row:(row.st_dev,row.st_ino,row.st_mode,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
        target=destination/source.name;digest=hashlib.sha256();copied=0
        with source.open('rb') as stream,target.open('xb') as output:
            if identity(os.fstat(stream.fileno()))!=identity(before):raise ValueError('Ownership original changed before copy')
            while True:
                check();block=stream.read(65536)
                if not block:break
                copied+=len(block)
                if copied>size or len(block)>remaining():raise ValueError('Ownership original grew or exhausted source budget')
                digest.update(block);output.write(block);output.flush()
            if copied!=size or identity(os.fstat(stream.fileno()))!=identity(before) or identity(source.lstat())!=identity(before):raise ValueError('Ownership original changed while copied')
        original=ref(target,out)
        if original['bytes']!=size or original['sha256']!=digest.hexdigest():raise ValueError('Retained ownership original differs')
        rows.append(dict(originalPath=str(source),original=original));used+=size
    return rows,used

def acquire(out,selected_rows,ownership,ledger_ref,target,remaining,stage,ref,check,*,sdk_profile='module-bookworm-gcc12'):
    if target not in ('linux-x64','linux-arm64'):raise ValueError('Fixed SDK target required')
    retained,ownership_bytes=preserve_ownership(out,ownership,remaining,ref,check)
    spec=importlib.util.spec_from_file_location('sdk_debian_binary_legal',HERE/'sdk-debian-binary-originals.py')
    legal=importlib.util.module_from_spec(spec);spec.loader.exec_module(legal)
    profile_spec=importlib.util.spec_from_file_location('sdk_binary_profile',HERE/'qlever_compiler_profile.py');profiles=importlib.util.module_from_spec(profile_spec);profile_spec.loader.exec_module(profiles)
    declared=profiles.declared_profile(sdk_profile)
    binary_ref,binary_bytes=legal.acquire(out,selected_rows,retained,ledger_ref,target,remaining,stage,ref,check,security_suite=declared['distribution']+'-security')
    return binary_ref,binary_bytes,ownership_bytes
