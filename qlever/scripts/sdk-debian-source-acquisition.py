"""Producer-side exact source download; mechanical verification grants no authority."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import shutil

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('sdk_debian_mechanics',HERE/'sdk-debian-source-materials.py')
mechanics=importlib.util.module_from_spec(spec);spec.loader.exec_module(mechanics)
MAX_ORIGINAL=512*1024**2

def preserve(source,destination,remaining,check_budget):
    before=source.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_size>min(MAX_ORIGINAL,remaining):
        raise ValueError('SDK Debian index original budget/type')
    identity=lambda row:(row.st_dev,row.st_ino,row.st_size,row.st_mtime_ns,row.st_ctime_ns)
    with source.open('rb') as original,destination.open('xb') as target:
        if identity(os.fstat(original.fileno()))!=identity(before):raise ValueError('Debian index original changed')
        copied=0
        while True:
            check_budget();block=original.read(65536)
            if not block:break
            copied+=len(block)
            if copied>before.st_size or shutil.disk_usage(destination.parent).free-len(block)<2*1024**3:
                raise ValueError('SDK Debian index growth/disk budget')
            target.write(block)
        if identity(os.fstat(original.fileno()))!=identity(before) or identity(source.lstat())!=identity(before):
            raise ValueError('Debian index original changed')
    return before.st_size

def acquire(out,selected,ownership,ledger,remaining,stage,ref,check_budget,
            lists=Path('/var/lib/apt/lists'),keyring=Path('/usr/share/keyrings/debian-archive-keyring.gpg')):
    """stage(name, argv, cwd) must supervise actual process and enforce cumulative budget."""
    out=Path(out);destination=out/'debian-source';destination.mkdir(exist_ok=False)
    mapping=mechanics.required_sources(selected,ownership,(out/ledger['path']).read_bytes())
    indexes=destination/'indexes';indexes.mkdir();retained={};used=0
    sources=sorted(path for path in lists.iterdir() if '_source_Sources' in path.name)
    releases=sorted(lists.glob('*_InRelease'))
    if not sources or not releases:raise ValueError('Actual Debian Sources/InRelease originals required')
    for path in [*sources,*releases,keyring]:
        check_budget();target=indexes/path.name
        used+=preserve(path,target,remaining-used,check_budget);retained[path.name]=ref(target,out)
    index_rows=[];verified={}
    for source in sources:
        matches=[path for path in releases if source.name.startswith(path.name.removesuffix('InRelease'))]
        if len(matches)!=1:raise ValueError('Debian Sources requires one actual suite InRelease')
        release=matches[0]
        if release.name not in verified:
            verified[release.name]=stage('debian-index-'+str(len(verified)),
                ['gpgv','--status-fd','1','--keyring',str(indexes/keyring.name),str(indexes/release.name)],out)
        index_rows.append(dict(inRelease=retained[release.name],sources=retained[source.name],
                               keyring=retained[keyring.name],verificationStage=verified[release.name]))
    packages=[]
    for index,identity in enumerate(mapping['packages']):
        check_budget();directory=destination/('package-'+format(index,'04d'));directory.mkdir()
        receipt=stage('debian-source-'+str(index),['apt-get','-o','APT::Get::AllowUnauthenticated=false',
            'source','--download-only','--only-source',identity['name']+'='+identity['version']],directory)
        originals=mechanics.verify_source_directory(directory,identity['name'],identity['version'],remaining-used,check_budget=check_budget)
        if any(row['bytes']>MAX_ORIGINAL for row in [originals['dsc'],*originals['files']]):
            raise ValueError('SDK Debian source member exceeds existing shard/member budget')
        used+=originals['totalBytes']
        def checked_ref(row):
            actual=ref(directory/row['path'],out)
            if any(actual[key]!=row[key] for key in ['bytes','sha256']):
                raise ValueError('Verified Debian source changed before reference')
            return actual
        packages.append(dict(**identity,dsc=checked_ref(originals['dsc']),
            files=[checked_ref(row) for row in originals['files']],
            acquisition={key:receipt[key] for key in ['receipt','stdout','stderr']}))
    result=dict(schemaVersion=1,kind='qlever-sdk-exact-debian-source-originals',sourceIdentities=ledger,
        packages=packages,indexOriginals=index_rows,unresolvedInputs=mapping['unresolvedInputs'],totalBytes=used,
        pending=['Debian-Sources-to-signed-InRelease-checksum-binding-unverified',
                 'official-source-origin-and-custody-not-granted-by-producer'])
    target=destination/'materials.json';target.write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    return ref(target,out),used
