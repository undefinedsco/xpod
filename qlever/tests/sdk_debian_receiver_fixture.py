"""Tiny acquisition fixture; fake acquisition commands, real producer serialization."""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[2]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
acquisition=load('acquisition_fixture','sdk-debian-source-acquisition.py')
image=load('image_fixture','sdk-image-originals.py')
root=Path(sys.argv[1]).resolve();out=root/'originals';inner=out/'inner';inner.mkdir(parents=True)
lists=root/'lists';lists.mkdir();(lists/'repo_dists_bookworm_InRelease').write_bytes(b'fixture signature')
(lists/'repo_dists_bookworm_main_source_Sources').write_bytes(b'fixture source index')
keyring=root/'keyring.gpg';keyring.write_bytes(b'fixture keyring')
ledger=inner/'ledger.raw';ledger.write_bytes(b'libfoo:amd64\t1.0+b1\tfoo\t1.0\n')
def stage(name,argv,cwd):
    if argv[0]=='apt-get':
        data=b'actual tiny source original';filename='foo_1.0.tar.gz';(cwd/filename).write_bytes(data)
        (cwd/'foo_1.0.dsc').write_text('Format: 3.0 (native)\nSource: foo\nVersion: 1.0\nChecksums-Sha256:\n '+hashlib.sha256(data).hexdigest()+' '+str(len(data))+' '+filename+'\n')
    result={}
    for key in ['receipt','stdout','stderr']:
        path=inner/'stages'/name/key;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'fixture command original')
        result[key]=image.commands.ref(path,inner)
    return result
original_ref,_=acquisition.acquire(inner,['/usr/include/foo.h'],{'libfoo:amd64':b'/usr/include/foo.h\n'},image.commands.ref(ledger,inner),100000,stage,image.commands.ref,lambda:None,lists,keyring)
public_ref=image.receiver_debian_collection(out,original_ref)
(inner/'before.json').write_text('{}')
(inner/'after.json').write_text(json.dumps(dict(shards=[],sourcePackageIdentityRaw=image.commands.ref(ledger,inner))))
(out/'context.tar').write_bytes(b'fixture context')
(out/'context.json').write_text(json.dumps(dict(archive=image.commands.ref(out/'context.tar',out))))
master=dict(kind='qlever-linux-sdk-originals',identity=dict(sourceSha='a'*40,target='linux-x64'),debianSources=public_ref,
    inputs=dict(before=image.commands.ref(inner/'before.json',out),after=image.commands.ref(inner/'after.json',out),shards=[]),sourceContext=image.commands.ref(out/'context.json',out))
(out/'materials.json').write_text(json.dumps(master))
print(json.dumps(dict(root=str(out),innerCollection=image.commands.ref(inner/original_ref['path'],out),receiverCollection=public_ref)))
