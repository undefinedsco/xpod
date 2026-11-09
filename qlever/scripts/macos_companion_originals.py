"""Collect actual installed inputs; never infer source/build admission from bottles."""
import hashlib
import os
from pathlib import Path
import shlex
import shutil

BUDGET=128*1024**2
MEMBERS=512

def sha(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(65536),b''):value.update(block)
    return value.hexdigest()

def parse_copy_commands(raw,cellar,runtime):
    cellar=Path(cellar);runtime=Path(runtime);result={}
    for line in raw.splitlines():
        if not line.strip().startswith('cp -n '):continue
        tokens=shlex.split(line.strip())
        if len(tokens)!=4 or tokens[:2]!=['cp','-n']:raise ValueError('Unexpected bundler copy command')
        source,destination=map(Path,tokens[2:])
        try:relative=source.relative_to(cellar);member=destination.relative_to(runtime)
        except ValueError:raise ValueError('Bundler copy outside controlled roots') from None
        if len(relative.parts)<4 or len(member.parts)!=2 or member.parts[0]!='lib' or '..' in relative.parts or '..' in member.parts:
            raise ValueError('Unexpected bundler source layout')
        if str(member) in result:raise ValueError('Duplicate bundler copy destination')
        result[str(member)]=dict(source=str(source),formula=relative.parts[0],version=relative.parts[1])
    return result

def collect(raw,cellar,runtime,destination,free=shutil.disk_usage):
    cellar=Path(cellar).resolve(strict=True);runtime=Path(runtime).resolve(strict=True)
    destination=Path(destination);destination.mkdir(parents=True,exist_ok=False)
    copies=parse_copy_commands(raw,cellar,runtime)
    actual={str(path.relative_to(runtime)) for path in (runtime/'lib').iterdir() if path.is_file() and not path.is_symlink()}
    if set(copies)!=actual:raise ValueError('Actual companion inventory differs from observed bundler copies')
    files=[];saved={};total=0;origins=[]
    def copy(original,relative):
        nonlocal total
        original=Path(original).resolve(strict=True)
        if not original.is_relative_to(cellar) or not original.is_file():raise ValueError('Installed original escapes Cellar')
        if str(original) in saved:return saved[str(original)]
        size=original.stat().st_size;total+=size
        if total>BUDGET or len(files)>=MEMBERS or free(destination).free-size<2*1024**3:raise ValueError('Companion original budget')
        target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True)
        identity=original.stat()
        before=sha(original)
        with original.open('rb') as source,target.open('xb') as output:
            written=0
            for block in iter(lambda:source.read(65536),b''):
                written+=len(block)
                if written>size or free(destination).free-len(block)<2*1024**3:raise ValueError('Companion original changed or disk floor')
                output.write(block)
        if sha(original)!=before or sha(target)!=before or (original.stat().st_dev,original.stat().st_ino,original.stat().st_size,original.stat().st_mtime_ns,original.stat().st_mode)!=(identity.st_dev,identity.st_ino,identity.st_size,identity.st_mtime_ns,identity.st_mode):raise ValueError('Installed original changed during collection')
        ref=dict(path=str(target.relative_to(destination)),sizeBytes=size,sha256=before)
        files.append(ref);saved[str(original)]=ref
        origins.append(dict(file=ref,originalPath=str(original),device=identity.st_dev,inode=identity.st_ino,mode=identity.st_mode&0o7777))
        return ref
    bindings=[];packages={}
    for member,observed in sorted(copies.items()):
        source=Path(observed['source']).resolve(strict=True)
        keg=cellar/observed['formula']/observed['version']
        if not keg.resolve(strict=True).is_relative_to(cellar):raise ValueError('Keg escapes Cellar')
        key=str(keg.relative_to(cellar))
        if key not in packages:
            receipt=keg/'INSTALL_RECEIPT.json';recipes=sorted((keg/'.brew').glob('*.rb'))
            package=dict(formula=observed['formula'],version=observed['version'],terms=[],recipes=[],pending=[])
            if receipt.is_file():package['installationReceipt']=copy(receipt,Path('kegs')/key/'INSTALL_RECEIPT.json')
            else:package['pending'].append('installed-receipt-unavailable')
            for recipe in recipes:package['recipes'].append(copy(recipe,Path('kegs')/key/'.brew'/recipe.name))
            if not recipes:package['pending'].append('installed-formula-original-unavailable')
            candidates=list(keg.iterdir())
            docs=keg/'share/doc'
            if docs.is_dir():candidates+=list(docs.rglob('*'))
            for original in sorted(candidates):
                if original.is_file() and original.name.lower().startswith(('license','copying','copyright','notice','readme')):
                    package['terms'].append(copy(original,Path('kegs')/key/original.relative_to(keg)))
            if not package['terms']:package['pending'].append('actual-terms-original-unavailable')
            packages[key]=package
        original=copy(source,Path('kegs')/key/source.relative_to(keg))
        binary=runtime/member
        bindings.append(dict(member=dict(path=member,sizeBytes=binary.stat().st_size,sha256=sha(binary)),
            installedOriginal=original,observedCopySource=observed['source'],originalMode=source.stat().st_mode&0o7777,
            package=key,status='observed-bundler-input-originals',
            pending=['exact-upstream-source-originals-unavailable','bottle-build-inputs-unavailable','binary-transformation-reproduction-unverified']))
    return dict(schemaVersion=1,status='companion-installed-originals',releaseAccepted=False,
                files=files,originals=origins,bindings=bindings,packages=list(packages.values()),
                scope='Actual installed binary/formula/receipt/terms bytes; no source-build or license clearance inferred')

if __name__=='__main__':
    import argparse,json
    parser=argparse.ArgumentParser();parser.add_argument('--build-raw',required=True);parser.add_argument('--cellar',required=True)
    parser.add_argument('--runtime',required=True);parser.add_argument('--out',required=True)
    args=parser.parse_args();raw_path=Path(args.build_raw)
    if raw_path.stat().st_size>16*1024**2:raise ValueError('Bundler raw budget exceeded')
    root=Path(args.out);root.mkdir(parents=True,exist_ok=False)
    result=collect(raw_path.read_text(),args.cellar,args.runtime,root/'originals')
    result['buildRaw']=dict(path='stages/native-build.raw.log',sizeBytes=raw_path.stat().st_size,sha256=sha(raw_path))
    manifest=root/'materials.json';manifest.write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    print(json.dumps(dict(schemaVersion=1,status='companion-originals-collected',sha256=sha(manifest),sizeBytes=manifest.stat().st_size)))
