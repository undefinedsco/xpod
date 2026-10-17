import base64
import hashlib
import importlib.util
import json
import os
import shutil
import time
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('upstream_test',ROOT/'qlever/scripts/sdk-upstream-source-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Budget:
    def check(self,reserve=0):pass
    def timeout(self,cap,reserve=0):return min(cap,5)
def git(source,*args,input=None):
    return subprocess.run(['git',*args],cwd=source,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True).stdout

class UpstreamSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'.test-data/sdk-upstream-source').mkdir(parents=True,exist_ok=True)
    def fixture(self,root):
        source=root/'source';source.mkdir();git(source,'init','-q');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.invalid')
        (source/'previous.h').write_text('previous history only\n');git(source,'add','.');git(source,'commit','-qm','parent')
        parent=git(source,'rev-parse','HEAD').decode().strip();(source/'previous.h').unlink()
        (source/'main.h').write_text('original\n');(source/'remove.h').write_text('remove\n');(source/'alias.h').symlink_to('main.h')
        git(source,'add','-A');git(source,'commit','-qm','locked');commit=git(source,'rev-parse','HEAD').decode().strip()
        (source/'main.h').write_text('patched\n');(source/'main.h').chmod(0o755);(source/'remove.h').unlink();(source/'added.h').write_text('added\n')
        git(source,'add','-N','added.h');patch=git(source,'diff','--binary','HEAD');git(source,'reset','--hard','HEAD');git(source,'clean','-fd')
        component=root/'component';patches=component/'patches';patches.mkdir(parents=True)
        (patches/'series').write_bytes(b'change.patch\n');(patches/'change.patch').write_bytes(patch)
        value=hashlib.sha256(b'change.patch\n');value.update(b'change.patch\0');value.update(patch)
        (component/'qlever.lock.json').write_text(json.dumps(dict(repository='local-fixture',commit=commit,patchSeriesSha256=value.hexdigest())))
        inner=root/'materials';inner.mkdir();collector=module.Collector(source,component,inner/'upstream-source',Budget())
        return source,component,inner,collector,parent
    def test_actual_local_git_pack_closes_current_tree_without_parent_history(self):
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve());collector.before()
            base=collector.base;ids=set((collector.out/base['objectIds']['path']).read_text().splitlines())
            self.assertIn(base['rootTree'],ids);self.assertIn(base['commit'],ids);self.assertNotIn(parent,ids)
            bare=Path(directory)/'bare';bare.mkdir();git(bare,'init','--bare','-q')
            with (collector.out/base['objectPack']['path']).open('rb') as stream:
                subprocess.run(['git','index-pack','--stdin'],cwd=bare,stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
            actual=git(bare,'ls-tree','-r','-t','-z','--full-tree',base['commit'])
            self.assertEqual(actual,(collector.out/base['treeListing']['path']).read_bytes())
            index=next((bare/'objects/pack').glob('*.idx'));verified=git(bare,'verify-pack','-v',str(index)).decode().splitlines()
            objects=[line.split() for line in verified if module.OID.fullmatch(line.split()[0])]
            self.assertEqual({row[0] for row in objects},ids)
            self.assertTrue(all(row[1] in ('commit','tree','blob') and len(row)==5 for row in objects))
            inventory=json.loads((collector.out/base['prepatchInventory']['path']).read_text())['files']
            self.assertEqual(base64.b64decode(next(row for row in inventory if row['path']=='alias.h')['readlinkBase64']),b'main.h')
    def test_real_patch_added_deleted_mode_and_selected_inputs_mapping(self):
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve());collector.before()
            patch=component/'patches/change.patch'
            collector.patch(0,['git','apply','--check',str(patch)]);collector.patch(0,['git','apply',str(patch)])
            collection=collector.after();self.assertEqual(collection['addedPaths'],['added.h']);self.assertEqual(collection['deletedPaths'],['remove.h'])
            rows=[]
            for name in ['main.h','added.h']:
                file=source/name;data=file.read_bytes();rows.append(dict(originalPath=str(file),archivePath=str(file).lstrip('/'),bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),mode=file.stat().st_mode&0o7777))
            inventory=dict(files=rows);(inner/'inputs-after.json').write_text(json.dumps(inventory))
            reference,total=module.finalize(inner,source,inventory,[dict(name='configure'),dict(name='compile')],lambda:None)
            final=json.loads((inner/reference['path']).read_text());mapping=json.loads((inner/final['selectedInputs']['path']).read_text())
            self.assertEqual([row['sourceRelativePath'] for row in mapping['files']],['main.h','added.h'])
            self.assertEqual(final['phaseBindings']['compile']['name'],'compile');self.assertGreater(total,0)
            self.assertEqual(mapping['files'][0]['postpatchEntry']['mode'],'100755')
            image_spec=importlib.util.spec_from_file_location('upstream_image_test',ROOT/'qlever/scripts/sdk-image-originals.py')
            image=importlib.util.module_from_spec(image_spec);image_spec.loader.exec_module(image)
            outer=Path(directory)/'sdk';outer.mkdir();original_bytes=(inner/reference['path']).read_bytes()
            inner.rename(outer/'inner')
            public_ref=image.receiver_upstream_collection(outer,reference)
            public=json.loads((outer/public_ref['path']).read_text());original_ref=public.pop('innerMaterials')
            self.assertEqual((outer/original_ref['path']).read_bytes(),original_bytes)
            self.assertEqual(original_ref['sha256'],hashlib.sha256(original_bytes).hexdigest())
            self.assertEqual(public,module.root_refs(final,'inner'))
            inner=outer/'inner'

            changed=dict(files=[dict(rows[0],sha256='0'*64)])
            with self.assertRaisesRegex(ValueError,'selected source differs'):module.finalize(inner,source,changed,[],lambda:None)
    def test_existing_apply_entry_records_actual_patch_processes(self):
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve())
            shutil.rmtree(collector.out)
            scripts=component/'scripts';scripts.mkdir()
            for name in ['apply-patches.py','verify-lock.py','sdk-upstream-source-materials.py','sdk-execution-budget.py']:
                shutil.copyfile(ROOT/'qlever/scripts'/name,scripts/name)
            env=dict(os.environ,XPOD_QLEVER_UPSTREAM_MATERIALS_DIR=str(collector.out),
                     XPOD_QLEVER_SDK_DEADLINE_UNIX=str(time.time()+20500))
            result=subprocess.run(['/usr/bin/python3',str(scripts/'apply-patches.py'),'--source',str(source)],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            self.assertEqual(result.returncode,0,result.stderr.decode())
            value=json.loads((collector.out/'materials.json').read_text())
            self.assertEqual((source/'main.h').read_text(),'patched\n')
            self.assertEqual([row['name'] for row in value['stages']][-2:],['patch-0-check','patch-0-apply'])
            for row in value['stages']:
                receipt=json.loads((inner/row['receipt']['path']).read_text())
                self.assertTrue(receipt['actualWait']);self.assertEqual(receipt['exit'],0)
                self.assertEqual(receipt['pgid'],receipt['parentPgid'])
    def test_actual_file_growth_is_rejected_on_first_over_limit_chunk(self):
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve())
            target=source/'main.h';target.write_bytes(b'x'*(65536+8))
            original_open=Path.open;reads=[]
            class GrowingReader:
                def __init__(self,stream):self.stream=stream
                def __enter__(self):return self
                def __exit__(self,*args):self.stream.close()
                def fileno(self):return self.stream.fileno()
                def read(self,size):
                    reads.append(size);data=self.stream.read(size)
                    if len(reads)==1:
                        with original_open(target,'ab') as writer:writer.write(b'growth'*40000)
                    return data
            def opened(path,mode='r',*args,**kwargs):
                stream=original_open(path,mode,*args,**kwargs)
                return GrowingReader(stream) if path==target and mode=='rb' else stream
            with patch.object(Path,'open',opened):
                with self.assertRaisesRegex(ValueError,'grew beyond observed bound'):
                    collector.observe_file('main.h')
            self.assertEqual(reads,[65536,65536])
            self.assertGreater(target.stat().st_size,2*65536)
    def test_mutated_prepatch_and_changed_patch_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve())
            (source/'main.h').write_text('different\n')
            with self.assertRaisesRegex(ValueError,'prepatch file differs'):collector.before()
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=ROOT/'.test-data/sdk-upstream-source') as directory:
            source,component,inner,collector,parent=self.fixture(Path(directory).resolve());collector.before()
            patch=component/'patches/change.patch';patch.write_bytes(patch.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError,'patch changed'):collector.patch(0,['git','apply','--check',str(patch)])

if __name__=='__main__':unittest.main()
