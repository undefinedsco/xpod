"""SigQ shared-UID counters cannot change stopped-task authority."""
import copy,hashlib
from unittest.mock import patch
from qlever.tests import test_sdk_setresuid_runtime as fixture
m=fixture.m
class Tests(fixture.Tests):
 def sample_with(self,change,role='status'):
  original=m.StoppedIdentityNoopTransition._read;seen=0
  def read(obj,kind,maximum):
   nonlocal seen
   row=original(obj,kind,maximum)
   if kind==role:
    seen+=1
    if seen%2==0:
     row=dict(row);row['data']=change(row['data']);raw=row['data'].encode();row.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
   return row
  with patch.object(m.StoppedIdentityNoopTransition,'_read',read):
   obj=self.entry();exit=self.finish(obj)
  return obj.observation,exit
 def test_shared_counter_change_roundtrips_producer_and_receiver(self):
  entry,exit=self.sample_with(lambda raw:raw.replace('SigQ: 0/','SigQ: 19/'))
  rows=entry['observation']['statusOriginals'];self.assertNotEqual(rows[0]['sha256'],rows[1]['sha256'])
  self.assertEqual(m.verify_setresuid_original_pair(entry,exit)['pid'],49)
  bad=copy.deepcopy(entry);bad['observation']['statusOriginals'][1]['sha256']='0'*64
  with self.assertRaises(ValueError):m.verify_stopped_identity_noop_original(bad,'entry')
 def test_shared_counter_limit_format_presence_remain_strict(self):
  for replacement in ['', 'SigQ: 0/1000\nSigQ: 2/1000\n','SigQ: 0/1001\n','SigQ: -1/1000\n','SigQ: 01/1000\n','SigQ: 1/01\n','SigQ: 18446744073709551616/1000\n','SigQ: 1/x\n']:
   with self.subTest(replacement=replacement),self.assertRaises(ValueError):self.sample_with(lambda raw:raw.replace('SigQ: 0/1000\n',replacement))
 def test_unknown_security_signal_and_stat_changes_refuse(self):
  for old,new in [('Uid: 0','Uid: 1'),('TracerPid:','TracerPid: 99'),('State: t','State: R'),('NoNewPrivs: 1','NoNewPrivs: 0'),('CapEff: 0','CapEff: 1')]:
   with self.subTest(old=old),self.assertRaises(ValueError):self.sample_with(lambda raw:raw.replace(old,new))
  for key in ['UnknownFutureSecurity','SigPnd','ShdPnd','SigBlk','SigIgn','SigCgt','Seccomp']:
   with self.subTest(key=key),self.assertRaises(ValueError):self.sample_with(lambda raw:raw+key+': 1\n')
  with self.assertRaises(ValueError):self.sample_with(lambda raw:raw.replace('1234','1235'),'stat')
 def test_receiver_rejects_limit_and_unknown_drift_with_valid_hashes(self):
  entry,exit=self.sample_with(lambda raw:raw.replace('SigQ: 0/','SigQ: 19/'))
  for change in [lambda raw:raw.replace('/1000','/1001'),lambda raw:raw+'UnknownFutureSecurity: 1\n',lambda raw:raw.replace('SigQ: 19/1000\n','')]:
   bad=copy.deepcopy(entry);row=bad['observation']['statusOriginals'][1];row['data']=change(row['data']);raw=row['data'].encode();row.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
   with self.assertRaises(ValueError):m.verify_stopped_identity_noop_original(bad,'entry')
 def test_refusal_diagnostic_is_bounded_metadata_only(self):
  import contextlib,io,json
  from qlever.tests.test_sdk_terminal_authority import backend
  observer=object.__new__(backend.Observer);observer.deny_optional_io_uring=True;observer.emit=lambda row:row
  record=dict(arch=0xc000003e,nr=101,args=[0]*6,sequence=7)
  stderr=io.StringIO()
  with contextlib.redirect_stderr(stderr),self.assertRaisesRegex(ValueError,'external-memory-writer'):
   observer.enforce_executable_memory(49,record)
  prefix,raw=stderr.getvalue().strip().split(' ',1);self.assertEqual(prefix,'SDK_EXECUTABLE_MEMORY_REFUSED');value=json.loads(raw)
  self.assertEqual(set(value),{'arch','nr','pid','entrySequence','reason'});self.assertEqual(value['nr'],101);self.assertLess(len(raw),512)
