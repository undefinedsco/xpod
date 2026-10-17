"""Bounded mechanical inventory checks for original Mac runtime material ZIPs."""
import hashlib
import json
import zipfile
import tarfile

LIMIT=1536*1024**2
MEMBERS=40000

def safe(name):
    return bool(name) and not name.startswith('/') and '\\' not in name and not any(ord(char)<32 or ord(char)==127 for char in name) and all(part not in ('','.','..') for part in name.split('/'))

def validate(archive, target, expected_source=None):
    if target not in ('darwin-arm64','darwin-x64'): raise ValueError('Mac native ZIP target required')
    with zipfile.ZipFile(archive) as bundle:
        index={};total=0
        for entry in bundle.infolist():
            name=entry.filename.rstrip('/')
            if not safe(name) or name in index or (entry.external_attr>>16)&0o170000 not in (0,0o100000,0o040000):
                raise ValueError('Unsafe original native ZIP inventory')
            total+=entry.file_size
            if total>LIMIT or entry.file_size>512*1024**2 or len(index)>=MEMBERS: raise ValueError('Native ZIP inventory budget')
            index[name]=entry
        def read(name,maximum=8*1024**2):
            entry=index.get(name)
            if not entry or entry.is_dir() or entry.file_size>maximum: raise ValueError('Missing/bounded native ZIP original: '+name)
            return bundle.read(entry)
        def record(name): return json.loads(read(name))
        def check(name,ref):
            entry=index.get(name)
            if not entry or entry.is_dir() or entry.file_size!=ref.get('sizeBytes',ref.get('bytes')): raise ValueError('Native original size mismatch: '+name)
            digest=hashlib.sha256()
            with bundle.open(entry) as stream:
                for block in iter(lambda:stream.read(65536),b''):digest.update(block)
            if digest.hexdigest()!=ref['sha256']:raise ValueError('Native original hash mismatch: '+name)
        archive_name='qlever-local-runtime-'+target+'.tar.gz'
        acceptance=record('qlever-local-acceptance.json')
        if expected_source is not None and acceptance.get('sourceSha')!=expected_source:raise ValueError('Native acceptance source mismatch')
        # Legacy original format remains valid, with no arbitrary extra members.
        files={name for name,entry in index.items() if not entry.is_dir()}
        if files=={archive_name,'qlever-local-acceptance.json'}:return sorted(files)
        final=record('native-materials/final.json')
        if final.get('schemaVersion')!=1 or final.get('status')!='native-build-test-materials' or final.get('releaseAccepted') is not False or final.get('target')!=target:
            raise ValueError('Native final target/status mismatch')
        source=final.get('sourceSha')
        if not isinstance(source,str) or len(source)!=40 or any(char not in '0123456789abcdef' for char in source) or final.get('nativeBuildSourceSha')!=source:
            raise ValueError('Native original build source mismatch')
        if final['archive']['path']!=archive_name:raise ValueError('Native archive target mismatch')
        check(archive_name,final['archive'])
        allowed={archive_name,'qlever-local-acceptance.json','native-materials/final.json','native-materials/source-snapshot.json'}
        for field in ['sourceKit','metadata','inputsBefore','inputsAfter','sourceArchive','nativeReceipt','bindingProposal','inputObservation']:
            ref=final.get(field)
            if ref is None:
                if field in ['nativeReceipt','bindingProposal','inputObservation']:continue
                raise ValueError('Native original reference missing: '+field)
            if not safe(ref['path']):raise ValueError('Unsafe native final reference')
            name='native-materials/'+ref['path'];check(name,ref);allowed.add(name)
        metadata=record('native-materials/'+final['metadata']['path'])
        if metadata.get('target')!=target or metadata.get('record',{}).get('sourceSha')!=source or metadata.get('record',{}).get('binary')!=final.get('binary'):raise ValueError('Native metadata source/target mismatch')
        stages=metadata.get('stages',[])
        if not stages or len(stages)>256:raise ValueError('Native stage inventory missing')
        for stage in stages:
            for field in ['raw','receipt']:
                ref=stage[field]
                if not safe(ref['path']) or not ref['path'].startswith('stages/'):raise ValueError('Unsafe native stage reference')
                name='native-materials/'+ref['path'];check(name,ref);allowed.add(name)
            receipt=record('native-materials/'+stage['receipt']['path'])
            if receipt.get('actualWait') is not True or receipt.get('exit')!=0 or receipt.get('signal') is not None or receipt.get('resourceStop') is not None or receipt.get('rawClosedBeforeHash') is not True or receipt.get('ownedGroupAbsentAfterWait') is not True or receipt.get('rawSHA256')!=stage['raw']['sha256'] or receipt.get('supervisorError') is not None or receipt.get('cleanupErrors',[])!=[]:
                raise ValueError('Native stage closure mismatch')
        kit=record('native-materials/'+final['sourceKit']['path'])
        refs=kit.get('files',[])
        if kit.get('status')!='native-source-materials' or not refs or len(refs)>20000:raise ValueError('Native source inventory missing')
        source_index={ref['path']:ref for ref in refs}
        if len(source_index)!=len(refs) or any(not safe(name) for name in source_index):raise ValueError('Unsafe/duplicate native source inventory')
        # Uploaded directories may dereference a source link. The original link
        # itself remains in the bound source tar; these ZIP copies carry no link authority.
        def resolve(name):
            parts=name.split('/');steps=0;position=0
            while position<len(parts):
                ref=source_index.get('/'.join(parts[:position+1]))
                if ref and ref.get('type')=='symlink':
                    steps+=1
                    if steps>40:raise ValueError('Native ZIP source link loop')
                    target_name=ref.get('linkTarget','')
                    if target_name.startswith('/'):raise ValueError('Native ZIP source link absolute')
                    prefix=parts[:position]
                    for part in target_name.split('/'):
                        if part in ('','.'):continue
                        if part=='..':
                            floor=2 if prefix and prefix[0]=='fetchcontent' else 1
                            if len(prefix)<=floor:raise ValueError('Native ZIP source link escape')
                            prefix.pop()
                        else:prefix.append(part)
                    parts=prefix+parts[position+1:];position=0;continue
                position+=1
            return '/'.join(parts)
        tar_name='native-materials/'+final['sourceArchive']['path']
        seen=set();expanded=0
        with bundle.open(index[tar_name]) as stream,tarfile.open(fileobj=stream,mode='r|') as source_tar:
            for member in source_tar:
                name=member.name.removeprefix('./').rstrip('/')
                if member.isdir():
                    if name not in ('','.') and (not safe(name) or not any(key.startswith(name+'/') for key in source_index)):
                        raise ValueError('Unsafe source tar directory')
                    continue
                if not safe(name) or name in seen or name not in source_index:raise ValueError('Unknown/unsafe source tar member')
                seen.add(name);ref=source_index[name];expanded+=member.size
                if expanded>512*1024**2:raise ValueError('Source tar expanded budget')
                if ref.get('type')=='symlink':
                    raw=member.linkname.encode('utf8',errors='surrogateescape')
                    if not member.issym() or member.linkname!=ref['linkTarget'] or member.mode!=ref['mode'] or len(raw)!=ref['sizeBytes'] or hashlib.sha256(raw).hexdigest()!=ref['sha256']:
                        raise ValueError('Original source link mismatch')
                    resolved=resolve(name)
                    if resolved not in source_index and not any(key.startswith(resolved+'/') for key in source_index):raise ValueError('Broken original source link')
                else:
                    if not member.isfile() or member.size!=ref['sizeBytes']:raise ValueError('Original source tar size/type mismatch')
                    digest=hashlib.sha256()
                    with source_tar.extractfile(member) as original:
                        for block in iter(lambda:original.read(65536),b''):digest.update(block)
                    if digest.hexdigest()!=ref['sha256']:raise ValueError('Original source tar hash mismatch')
        if seen!=set(source_index):raise ValueError('Original source tar inventory incomplete')
        for name in files:
            if name.startswith('native-materials/source-kit/'):
                relative=name[len('native-materials/source-kit/'):];resolved=resolve(relative);ref=source_index.get(resolved)
                if not ref or ref.get('type')=='symlink':raise ValueError('Unknown native source ZIP member')
                check(name,ref);allowed.add(name)
        unknown=files-allowed
        if unknown:raise ValueError('Unknown original native ZIP member: '+sorted(unknown)[0])
        for name in index:
            if index[name].is_dir() and not any(file.startswith(name+'/') for file in files):raise ValueError('Unbound native ZIP directory')
        return sorted(files)

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('target');parser.add_argument('--source')
    args=parser.parse_args();validate(args.archive,args.target,args.source)
