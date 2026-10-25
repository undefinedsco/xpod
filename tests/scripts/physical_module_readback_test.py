"""Run the real archive builder/readback against a fixed legacy reader and adversarial fixtures."""
import copy, gzip, hashlib, io, json, pathlib, random
import subprocess, sys, tarfile, tempfile, time

BASE = pathlib.Path(__file__).resolve().parents[2]
LEGACY_READER = "import sys,tarfile,json,hashlib\nwith tarfile.open(sys.argv[1]) as t:\n members=t.getmembers();names=[m.name for m in members]\n assert len(names)==len(set(names)) and len(names)<=50000 and all(m.isfile() and m.name.startswith('package/') and '..' not in m.name.split('/') for m in members)\n by_name={m.name:m for m in members}\n manifest=json.load(t.extractfile(by_name['package/package.json']));rows=manifest['xpodModule']['files']\n assert set(names)-{'package/package.json'}=={'package/'+r['path'] for r in rows}\n for row in rows:\n  member=by_name['package/'+row['path']];body=t.extractfile(member).read()\n  assert len(body)==row['size'] and hashlib.sha256(body).hexdigest()==row['sha256'] and member.mode==row['mode']\n"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def embedded(path, label):
    text = pathlib.Path(path).read_text()
    start = text.index("const " + label + "=spawnSync('python3',['-c',`") + len("const " + label + "=spawnSync('python3',['-c',`")
    return text[start:text.index("`", start)]

def verify(source, archive):
    counters = dict(decompressedBytes=0, decompressorReadCalls=0, gzipSeekCalls=0, gzipBackwardSeeks=0)
    original_read = gzip._GzipReader.read
    original_seek = gzip.GzipFile.seek
    def read(self, size=-1):
        value = original_read(self, size)
        counters['decompressorReadCalls'] += 1
        counters['decompressedBytes'] += len(value)
        return value
    def seek(self, offset, whence=0):
        before = self._buffer.tell()
        counters['gzipSeekCalls'] += 1
        value = original_seek(self, offset, whence)
        counters['gzipBackwardSeeks'] += int(value < before)
        return value
    gzip._GzipReader.read = read
    gzip.GzipFile.seek = seek
    sys.argv = ['actual-reader', str(archive)]
    start = time.monotonic()
    result = dict(accepted=True)
    try:
        exec(compile(pathlib.Path(source).read_text(), source, 'exec'), {'__name__': '__main__'})
    except Exception as error:
        result = dict(accepted=False, errorType=type(error).__name__, error=str(error)[:180])
    result.update(counters, seconds=time.monotonic()-start)
    print(json.dumps(result))

def main():
    source_path = BASE/'scripts/lib/physical-module-archive.ts'
    old_source, new_source = LEGACY_READER, embedded(source_path, 'readback')
    out = BASE/'.test-data/physical-module-readback'
    out.mkdir(parents=True, exist_ok=True)
    result = dict(cases=[])
    with tempfile.TemporaryDirectory(dir=out) as temporary:
        temp = pathlib.Path(temporary)
        for name, source in [('old-reader.py', old_source), ('new-reader.py', new_source)]:
            (temp/name).write_text(source)
        stage = temp/'stage'
        stage.mkdir()
        rng = random.Random(418)
        data = {}
        rows = []
        for n in range(10):
            name = 'payload/%02d.bin' % n
            body = bytes(rng.getrandbits(8) for _ in range(64*1024))
            data['package/'+name] = body
            path = stage/name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(body)
            rows.append(dict(path=name,size=len(body),sha256=digest(body),mode=0o644))
        manifest = json.dumps(dict(name='fixture', version='1',xpodModule=dict(files=rows))).encode()
        (stage/'package.json').write_bytes(manifest)
        # Exact normal production archive builder, not a substitute product packer.
        normal = temp/'normal.tar.gz'
        subprocess.run([sys.executable,'-c',embedded(source_path,'packed'),str(stage),str(normal)],check=True)
        normal_gz = normal.read_bytes()
        data['package/package.json'] = manifest

        def make(order=None, changed_manifest=None, special=None, omit=None):
            members = order or sorted(data)
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as tar:
                for name in members:
                    if name == omit:
                        continue
                    body = changed_manifest if name=='package/package.json' and changed_manifest is not None else data[name]
                    info = tarfile.TarInfo(name)
                    info.mode = 0o644
                    info.size = len(body)
                    if special and special[0] == name:
                        action = special[1]
                        if action=='symlink':
                            info.type=tarfile.SYMTYPE;info.linkname='payload/00.bin';info.size=0
                        elif action=='hardlink':
                            info.type=tarfile.LNKTYPE;info.linkname='package/payload/01.bin';info.size=0
                        elif action=='directory':
                            info.type=tarfile.DIRTYPE;info.size=0
                        elif action=='mode':
                            info.mode=0o755
                        elif action=='path':
                            info.name='package/../escape'
                    tar.addfile(info,io.BytesIO(body) if info.isfile() else None)
            return gzip.compress(stream.getvalue(),mtime=0)

        def check(name, blob):
            archive=temp/'case.tar.gz'
            archive.write_bytes(blob)
            row=dict(name=name,compressedBytes=len(blob))
            for variant in ['old','new']:
                run=subprocess.run([sys.executable,__file__,'--verify',str(temp/(variant+'-reader.py')),str(archive)],
                                   capture_output=True,text=True,timeout=45)
                if run.returncode: raise RuntimeError(run.stderr)
                row[variant]=json.loads(run.stdout)
            accepted = name in {'normal-production-builder-manifest-first', 'manifest-last',
                                'trailing-valid-gzip-member', 'trailing-zero-padding'}
            legacy_accepted = accepted or name in {'bad-gzip-crc', 'missing-gzip-trailer', 'trailing-nongzip-bytes'}
            assert row['new']['accepted'] == accepted, row
            assert row['old']['accepted'] == legacy_accepted, row
            if name in {'normal-production-builder-manifest-first', 'manifest-last'}:
                assert row['new']['gzipSeekCalls'] == 0, row
                assert row['old']['gzipBackwardSeeks'] > 0, row
                assert row['new']['decompressedBytes'] < row['old']['decompressedBytes'], row
            result['cases'].append(row)

        check('normal-production-builder-manifest-first',normal_gz)
        check('manifest-last',make(order=[x for x in sorted(data)if x!='package/package.json']+['package/package.json']))
        for kind in ['symlink','hardlink','directory','mode','path']:
            check(kind,make(special=('package/payload/00.bin',kind)))
        for field,value in [('sha256','0'*64),('size',12),('mode',0o755)]:
            wrong=copy.deepcopy(rows);wrong[0][field]=value
            check('manifest-wrong-'+field,make(changed_manifest=json.dumps({'xpodModule':{'files':wrong}}).encode()))
        check('duplicate-member',make(order=sorted(data)+['package/payload/00.bin']))
        check('missing-member',make(omit='package/payload/00.bin'))
        check('unexpected-member',make(changed_manifest=json.dumps({'xpodModule':{'files':rows[:-1]}}).encode()))
        check('malformed-manifest',make(changed_manifest=b'{broken'))
        crc=bytearray(normal_gz);crc[-8]^=1
        check('bad-gzip-crc',bytes(crc))
        check('missing-gzip-trailer',normal_gz[:-8])
        check('truncated-payload',normal_gz[:len(normal_gz)//2])
        check('trailing-nongzip-bytes',normal_gz+b'JUNK')
        check('trailing-valid-gzip-member',normal_gz+gzip.compress(b'ignored trailing payload',mtime=0))
        check('trailing-zero-padding',normal_gz+b'\0'*100)
    assert len(result['cases']) == 20
    print(json.dumps({'passed': len(result['cases'])}))

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--verify':
        verify(sys.argv[2],sys.argv[3])
    else:
        main()
