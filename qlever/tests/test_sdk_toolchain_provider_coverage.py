"""Existing raw parser plus sole provider verifier; no kernel/capability claim."""
import copy,hashlib,importlib.util,os,stat,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('provider_fd_fixture',ROOT/'qlever/tests/test_sdk_toolchain_fd_originals.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
def actual():
 rows,originals=fixture.fixture();image=rows[6];mapped=rows[7];binary=rows[4]['original'];identity=rows[4]['identity'];mounts=b'149 1 1:0 / /usr ro,relatime - ext4 /dev/root rw\n';name='capture-0002.original';originals[name]=mounts;ref=dict(path=name,bytes=len(mounts),sha256=hashlib.sha256(mounts).hexdigest())
 spec=importlib.util.spec_from_file_location('sole_provider',ROOT/'qlever/scripts/sdk-tool-provider-originals.py');provider=importlib.util.module_from_spec(spec);spec.loader.exec_module(provider)
 observation=dict(schemaVersion=1,kind='actual-stopped-tracee-tool-provider',pid=10,actualPath='/usr/bin/compiler',identity=identity,mountNamespace='mnt:[11]',mountNamespaceIdentity=[1,11,stat.S_IFREG,0,0,0],rootIdentity=[1,12,stat.S_IFDIR,0,0,0],heldFdinfoRaw='mnt_id:\t149\nino:\t2\n',namedFdinfoRaw='mnt_id:\t149\nino:\t2\n',provider=provider.provider_for('/usr/bin/compiler',mounts,identity,149),mountinfoOriginal=ref)
 def role():return dict(kind='toolchain-provider-original',pid=10,barrierSequence=4,fileOriginal=binary,observation=copy.deepcopy(observation))
 image['exe']['providerSequence']=8;mapped['parentCaptureSequence']=9;mapped['providerSequence']=10
 rows=rows[:6]+[dict(kind='toolchain-original',captureKind='mountinfo',observedPid=10,original=ref),role(),image,role(),mapped]+rows[8:]
 for sequence,row in enumerate(rows,1):row.update(sequence=sequence,phase='configure')
 return rows,originals
class ProviderCoverage(unittest.TestCase):
 def test_raw_stop_file_namespace_mountid_chain_reaches_private_projection(self):
  rows,originals=actual();result=fixture.observe(rows,originals);op=result['toolchainOperationCoverage']['operations'][0];self.assertEqual(result['toolchainStopProviderPending'],[])
  for value in [op['primaryFile'],*op['mapOriginals']]:self.assertEqual(value['stopReadonlyProvider']['provider']['mountId'],149);self.assertEqual(value['stopReadonlyProvider']['identityDecimal'],value['identityDecimal']);self.assertEqual(value['stopReadonlyProvider']['mountNamespace'],'mnt:[11]')
  self.assertFalse(result['toolchainSourceClosureVerified'])
 def test_missing_role_keeps_exact_pending(self):
  rows,originals=actual();rows[8]['exe']['providerSequence']=None;result=fixture.observe(rows,originals);self.assertIsNone(result['toolchainOperationCoverage']['operations'][0]['primaryFile']['stopReadonlyProvider']);self.assertTrue(any('unavailable:9:' in reason for reason in result['toolchainStopProviderPending']))
 def test_wrong_mountid_or_namespace_and_reused_role_rejected(self):
  for mutate in [lambda rows:rows[7]['observation'].update(namedFdinfoRaw='mnt_id:\t150\nino:\t2\n'),lambda rows:rows[7]['observation'].update(mountNamespace='mnt:[99]'),lambda rows:rows[10].update(providerSequence=8)]:
   rows,originals=actual();mutate(rows)
   with self.assertRaises(ValueError):fixture.observe(rows,originals)
 def test_changed_mount_bytes_with_consistent_reference_still_fail_readonly(self):
  rows,originals=actual();data=originals['capture-0002.original'].replace(b'ro,relatime',b'rw,relatime');originals['capture-0002.original']=data;ref=dict(path='capture-0002.original',bytes=len(data),sha256=hashlib.sha256(data).hexdigest());rows[6]['original']=ref
  for index in [7,9]:rows[index]['observation']['mountinfoOriginal']=ref
  with self.assertRaises(ValueError):fixture.observe(rows,originals)
if __name__=='__main__':unittest.main()
