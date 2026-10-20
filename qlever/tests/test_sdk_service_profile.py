import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest import mock
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 p=ROOT/'qlever/scripts'/name;spec=importlib.util.spec_from_file_location(name,p);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
profile=load('qlever_compiler_profile.py');service=load('sdk-service-profile-materials.py');route=load('sdk-readonly-normal-route.py');bindings=load('sdk-readonly-executor-bindings.py');collector=load('sdk-readonly-collection.py')
class ServiceProfileTest(unittest.TestCase):
 def test_profiles_preserve_pair_and_dockerfile_authority(self):
  self.assertEqual(profile.declared_profile('service-trixie')['c'],'clang-19');self.assertEqual(profile.declared_profile('service-trixie')['dockerfile'],'docker/qlever-runtime-sdk/Dockerfile')
  self.assertEqual(profile.declared_profile('module-bookworm-gcc12')['c'],'gcc-12')
  with self.assertRaises(RuntimeError):profile.declared_profile('service-module')
 def test_actual_service_interior_cannot_borrow_module_or_wrong_compiler(self):
  declared=profile.declared_profile('service-trixie');release=dict(ID='debian',VERSION_CODENAME='trixie');tools=dict(c='Debian clang version 19.1.7',cxx='Debian clang version 19.1.7',linker='Debian LLD 19.1.7')
  service.validate_interior(declared,release,'aarch64',tools)
  for osrelease,machine,actual in [(dict(release,VERSION_CODENAME='bookworm'),'aarch64',tools),(release,'armv7l',tools),(release,'aarch64',dict(tools,c='gcc version 12.2')),(release,'aarch64',dict(tools,linker='Debian LLD 18.1'))]:
   with self.assertRaises(ValueError):service.validate_interior(declared,osrelease,machine,actual)
 def test_actual_tool_input_roles_follow_the_same_compiler_profile(self):
  inner=load('sdk-inner-materials.py')
  self.assertEqual(inner.sdk_tools('module-bookworm-gcc12'),(('gcc-12','tool-gcc-12'),('g++-12','tool-gxx-12'),('ld.bfd','tool-ld-bfd'),*inner.COMMON_SDK_TOOLS))
  service_tools=inner.sdk_tools('service-trixie');self.assertEqual([name for name,_ in service_tools[:3]],['clang-19','clang++-19','ld.lld-19']);self.assertFalse(any('gcc' in name for name,_ in service_tools))
  self.assertEqual(profile.declared_profile('module-bookworm-gcc12')['compiler_program'],'cc1plus');self.assertEqual(profile.declared_profile('service-trixie')['compiler_program'],'clang')
 def test_service_metadata_reads_are_samefd_bounded_and_reject_replacement(self):
  base=ROOT/'.test-data/service-profile';base.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=base) as directory:
   root=Path(directory).resolve();path=root/'raw';path.write_bytes(b'actual')
   reference,data=service.original(path,lambda:None,6,keep_bytes=True);self.assertEqual(data,b'actual');self.assertEqual(reference['bytes'],6)
   with mock.patch.object(service.os,'read',wraps=service.os.read) as read:
    with self.assertRaises(ValueError):service.original(path,lambda:None,5,keep_bytes=True)
    read.assert_not_called()
   link=root/'alias';link.symlink_to(path)
   with self.assertRaises(ValueError):service.original(link,lambda:None,6)
   actual_read=service.os.read;changed=[False]
   def swap(fd,size):
    value=actual_read(fd,size)
    if value and not changed[0]:changed[0]=True;path.write_bytes(b'change')
    return value
   with mock.patch.object(service.os,'read',side_effect=swap):
    with self.assertRaises(ValueError):service.original(path,lambda:None,6,keep_bytes=True)
 def test_normal_prepared_command_and_repository_are_same_profile(self):
  for name,suffix in [('service-trixie',''),('module-bookworm-gcc12','-module-bookworm')]:
   identity=dict(sourceSha='a'*40,runId=1,runAttempt=1,target='linux-arm64',sdkProfile=name);command=route.prepared_argv('owned','linux/arm64',identity,2000000000,'/tmp/original')
   self.assertEqual(command[command.index('--file')+1],profile.declared_profile(name)['dockerfile']);self.assertEqual(collector.repository_for('linux-arm64',name),'ghcr.io/undefinedsco/xpod-qlever-sdk'+suffix+'-arm64')
  with self.assertRaises(ValueError):bindings.same_tuple(dict(identity,sdkProfile='other'),dict(identity,sdkProfile='other'))
if __name__=='__main__':unittest.main()
