import importlib.util
from pathlib import Path
import tempfile
import unittest
import os
import subprocess
import tarfile

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/observe-macos-native-materials.py'
spec=importlib.util.spec_from_file_location('source_links',SCRIPT)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SourceLinksTest(unittest.TestCase):
    def test_internal_repository_links_preserve_target_mode_and_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source=root/'repo';(source/'src').mkdir(parents=True)
            (source/'LICENSE').write_text('real terms');(source/'src/license').symlink_to('../LICENSE')
            rows=module.snapshot_sources([('engine',source)],root/'kit')
            link=next(row for row in rows if row['reference'].get('type')=='symlink')
            self.assertEqual(os.readlink(root/'kit/engine/src/license'),'../LICENSE')
            self.assertEqual(link['reference']['mode'],(source/'src/license').lstat().st_mode&0o7777)
            self.assertEqual(module.verify_source_snapshot(rows),[row['reference'] for row in rows])
            (source/'src/license').unlink();(source/'src/license').symlink_to('../LICENSE')
            # Retargeting is rejected independently of inode reuse.
            (source/'src/license').unlink();(source/'src/license').symlink_to('../missing')
            with self.assertRaisesRegex(RuntimeError,'src/license'): module.verify_source_snapshot(rows)

    def test_escape_absolute_broken_loop_and_outside_chain_rejected(self):
        for target in ['../outside','/etc/passwd','missing','loop']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);source=root/'repo';source.mkdir();(root/'outside').write_text('secret')
                (source/'loop').symlink_to(target)
                with self.assertRaisesRegex(RuntimeError,'loop'): module.snapshot_sources([('engine',source)],root/'kit')
                self.assertFalse((root/'kit/engine/loop').exists())

    def test_tar_preserves_link_bytes_without_dereference(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'repo';source.mkdir()
            (source/'target').write_text('original');(source/'link').symlink_to('target')
            module.snapshot_sources([('engine',source)],root/'kit')
            archive=root/'source.tar'
            subprocess.run(['tar','-cf',str(archive),'-C',str(root/'kit'),'.'],check=True,timeout=5)
            with tarfile.open(archive) as bundle:
                member=next(item for item in bundle.getmembers() if item.name.endswith('/link'))
                self.assertTrue(member.issym());self.assertEqual(member.linkname,'target')

    def test_nested_link_escape_rejected_before_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'repo';(source/'safe').mkdir(parents=True)
            (source/'a').symlink_to('safe/b');(source/'safe/b').symlink_to('../../secret')
            (root/'secret').write_text('not a source input')
            with self.assertRaisesRegex(RuntimeError,'a'): module.snapshot_sources([('engine',source)],root/'kit')

    def test_generated_inventory_tar_and_cache_preserve_links(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);materials=root/'native-materials';kit=materials/'source-kit'
            (kit/'engine/real').mkdir(parents=True)
            (kit/'engine/real/input').write_text('source')
            (kit/'engine/other').write_text('other')
            (kit/'engine/filelink').symlink_to('real/input')
            (kit/'engine/dirlink').symlink_to('real',target_is_directory=True)
            files=module.source_kit_inventory(kit)
            self.assertEqual(len(files),4)
            self.assertEqual(len([ref for ref in files if ref.get('type')=='symlink']),2)
            (materials/'source-kit.json').write_text(json.dumps(dict(files=files)))
            (materials/'metadata.json').write_text(json.dumps(dict(stages=[])))
            (materials/'inputs.json').write_text('{}')
            tar=materials/'source-kit.tar'
            subprocess.run(['tar','-cf',str(tar),'-C',str(kit),'.'],check=True,timeout=5)
            with tarfile.open(tar) as original:
                self.assertEqual(len([member for member in original.getmembers() if member.issym()]),2)
            (root/'runtime.tar').write_bytes(b'runtime archive test fixture')
            final=dict(status='native-build-test-materials',releaseAccepted=False,
                       archive=module.reference(root/'runtime.tar',root),
                       sourceArchive=module.reference(tar,materials),
                       sourceKit=module.reference(materials/'source-kit.json',materials),
                       metadata=module.reference(materials/'metadata.json',materials))
            for key in ['inputsBefore','inputsAfter','nativeReceipt','bindingProposal','inputObservation']:
                final[key]=module.reference(materials/'inputs.json',materials)
            (materials/'final.json').write_text(json.dumps(final))
            self.assertEqual(module.verify_cache(root),final)
            original_tar=tar.read_bytes();tar.write_bytes(b'changed original tar')
            with self.assertRaisesRegex(RuntimeError,'changed'): module.verify_cache(root)
            tar.write_bytes(original_tar)
            (kit/'engine/filelink').unlink();(kit/'engine/filelink').symlink_to('other')
            with self.assertRaisesRegex(RuntimeError,'inventory changed'): module.verify_cache(root)

    def test_kit_namespace_escape_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            kit=Path(directory);(kit/'engine').mkdir();(kit/'workspace').mkdir()
            (kit/'workspace/other').write_text('another source root')
            (kit/'engine/link').symlink_to('../workspace/other')
            with self.assertRaisesRegex(RuntimeError,'link'): module.source_kit_inventory(kit)

    def test_fetchcontent_namespace_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            kit=Path(directory);namespace=kit/'fetchcontent/lib-src';namespace.mkdir(parents=True)
            (namespace/'input').write_text('source');(namespace/'link').symlink_to('input')
            self.assertEqual(len(module.source_kit_inventory(kit)),2)
            other=kit/'fetchcontent/other-src';other.mkdir();(other/'input').write_text('outside namespace')
            (namespace/'link').unlink();(namespace/'link').symlink_to('../other-src/input')
            with self.assertRaisesRegex(RuntimeError,'link'): module.source_kit_inventory(kit)

    def test_internal_directory_link_not_dereferenced(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'repo';(source/'actual').mkdir(parents=True)
            (source/'actual/input').write_text('source');(source/'alias').symlink_to('actual',target_is_directory=True)
            rows=module.snapshot_sources([('engine',source)],root/'kit')
            self.assertEqual(len(rows),2)
            self.assertTrue((root/'kit/engine/alias').is_symlink())

if __name__=='__main__':unittest.main()
