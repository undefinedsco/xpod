"""Caller-owned root selection; raw declarations cannot select their own scope."""
import importlib.util,inspect,unittest
from pathlib import Path
P=Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py'
s=importlib.util.spec_from_file_location('generated_roots',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_sdk_default_and_native_explicit_root(self):
  self.assertEqual(m.BUILD_ROOT,'/opt/qlever-sdk/build')
  for root in [m.BUILD_ROOT,'/opt/xpod-qlever-local-runtime/build']:
   verifier=m.Verifier(lambda _:None,lambda _:None,build_root=root)
   self.assertEqual(verifier.build_root,root)
   link=m.raw_record((root+'/output').encode())
   m.kernel_link(link,root+'/output',verifier.build_root)
   with self.assertRaises((ValueError,AssertionError)):m.kernel_link(link,root+'/output','/different/build')
 def test_canonical_root_cannot_escape_or_alias(self):
  for root in ['', '/', 'relative', '/a/', '/a//b', '/a/../b', '/a/./b', '/a\\b', '/a\0b', '/a\nb', '/a\x7fb', '/'+('a'*4096),None]:
   with self.subTest(root=root),self.assertRaises((ValueError,AssertionError)):m.validated_build_root(root)
if __name__=='__main__':unittest.main()
