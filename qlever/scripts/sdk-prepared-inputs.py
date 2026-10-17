"""Private module SDK phase boundary; marker bytes cannot grant admission."""
import argparse
import hashlib
import json
from pathlib import Path

def digest(path):
    value=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda:stream.read(65536),b''):value.update(block)
    return value.hexdigest()

def inputs(root,build,identity,toolchain):
    result=dict(schemaVersion=1,buildIdentity=identity,toolchainIdentity=toolchain,files=[])
    for base,relative in [(root,'qlever.lock.json'),(build,'CMakeCache.txt'),(build,'compile_commands.json'),
                          (build,'CMakeFiles/qlever-server.dir/link.txt'),(build,'.xpod-source-manifest.pending')]:
        path=Path(base)/relative
        if path.is_symlink() or not path.is_file():raise ValueError('Prepared SDK input must be an original regular file: '+relative)
        result['files'].append(dict(path=str(path.resolve()),sizeBytes=path.stat().st_size,sha256=digest(path)))
    return result

def boundary(mode,root,build,identity,toolchain):
    marker=Path(build)/'.xpod-prepared-inputs.json'
    actual=inputs(root,build,identity,toolchain)
    if mode=='record':
        with marker.open('x') as output:json.dump(actual,output,sort_keys=True)
    elif mode=='verify':
        if marker.is_symlink() or json.loads(marker.read_text())!=actual:raise ValueError('Prepared SDK input boundary changed')
    else:raise ValueError('Unsupported private SDK phase')
    return actual

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['record','verify']);parser.add_argument('root');parser.add_argument('build')
    parser.add_argument('identity');parser.add_argument('toolchain');args=parser.parse_args()
    boundary(args.mode,args.root,args.build,args.identity,args.toolchain)
