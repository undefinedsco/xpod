"""Bounded pure slice reconstruction and FD inventory rejection, no authority."""
import importlib.util
import io
import time
from pathlib import Path
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('delta_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b);m=b.bindings
class Tests(unittest.TestCase):
 def test_many_partial_sparse_and_overwrite_projections(self):
  originals={};segments=[];expected=b''
  for index,(offset,data,count) in enumerate([(0,b'first',5),(12,b'gap',3),(2,b'REPLACE',3),(100,b'ignored',0)]+[(15+i*4096,bytes([i])*4096,4096) for i in range(24)]):
   ref=dict(path='capture-'+str(index).zfill(4)+'.original',bytes=len(data));originals[ref['path']]=data
   segments=m.write_segments(segments,offset,count,ref,1024**2)
   if count:expected=expected[:offset].ljust(offset,b'\0')+data[:count]+expected[offset+count:]
   actual=b''.join(m.segment_blocks(segments,lambda row:[originals[row['path']]]))
   self.assertEqual(actual,expected)
  original_bytes=sum(map(len,originals.values()));self.assertLess(original_bytes,100000);self.assertEqual(len(expected),98319)
  originals[ref['path']]=b'changed';
  with self.assertRaises(ValueError):list(m.segment_blocks(segments,lambda row:[originals[row['path']]]))
 def test_fd_scan_refuses_before_unbounded_collection(self):
  observer=b.Observer('/unused','/unused','/unused');observer.deadline=time.monotonic()+60;observer.check_budget=lambda:None;observer.current_phase='configure';observer.check=lambda:None
  class Entries:
   def __enter__(self):return (type('Entry',(),{'name':str(n)}) for n in range(5000))
   def __exit__(self,*args):pass
  with patch.object(b.os,'scandir',return_value=Entries()),self.assertRaisesRegex(AssertionError,'slots unsupported'):observer.bounded_fd_slots(7)
 def test_alias_key_count_refuses_not_truncates(self):
  observer=b.Observer('/unused','/unused','/unused');observer.deadline=time.monotonic()+60;observer.check_budget=lambda:None;observer.current_phase='configure';observer.tasks={7:dict(exited=False)};observer.check=lambda:None
  identity=[1,2,0o100600,0,1,1];item=type('Stat',(),dict(st_dev=1,st_ino=2))()
  with patch.object(observer,'bounded_fd_slots',return_value=list(map(str,range(65)))),patch.object(b.os,'stat',return_value=item),patch.object(b,'descriptor_flags',return_value=2),self.assertRaisesRegex(AssertionError,'alias keys unsupported'):observer.writable_aliases(identity)
 def test_delta_protocol_and_self_consistent_payload_tamper_rejected(self):
  import copy,hashlib,json
  spec=importlib.util.spec_from_file_location('legacy_write_fixture',ROOT/'qlever/tests/test_sdk_actual_write_projection.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
  rows,originals=fixture.ProtocolTests().fixture();window=next(row for row in rows if row['kind']=='actual-write-window');window['format']='bounded-write-delta-v1';window['initialBefore']=window['before'];window['before']={key:window['before'][key] for key in ['bytes','sha256']}
  transition=next(row for row in rows if row['kind']=='actual-write-transition');transition['after']={key:transition['after'][key] for key in ['bytes','sha256']}
  def inspect(rows,values):return m.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,_:values[name],{})
  self.assertEqual(inspect(rows,originals)['outputs'][0]['bytes'],3)
  bad=copy.deepcopy(rows);values=dict(originals);buffer=next(row for row in bad if row['kind']=='actual-write-window')['buffer'];values[buffer['path']]=b'xyz';buffer['sha256']=hashlib.sha256(b'xyz').hexdigest()
  for row in bad:
   if row['kind']=='write-original' and row['original']['path']==buffer['path']:row['original']['sha256']=buffer['sha256']
  with self.assertRaisesRegex(ValueError,'postimage'):inspect(bad,values)
 def test_exact_integer_ranges_partial_holes_and_protocol_negative(self):
  ref=dict(path='capture-0000.original',bytes=3)
  for offset,count in [(-1,3),(0,-1),(True,1),(0,True),(16,1),(15,2)]:
   with self.subTest(offset=offset,count=count),self.assertRaises(ValueError):m.write_segments([],offset,count,ref,16)
  self.assertEqual(b''.join(m.segment_blocks(m.write_segments([],4,2,ref,6),lambda _:[b'abc'])),bytes(4)+b'ab')
  import copy,json
  spec=importlib.util.spec_from_file_location('delta_negative_fixture',ROOT/'qlever/tests/test_sdk_actual_write_projection.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
  for field,value in [('position',-1),('offset',-1),('position',True),('offset',True),('count',True),('result',True)]:
   rows,originals=fixture.ProtocolTests().fixture();window=next(row for row in rows if row['kind']=='actual-write-window');window['format']='bounded-write-delta-v1';window['initialBefore']=window['before'];window['before']={key:window['before'][key] for key in ['bytes','sha256']};transition=next(row for row in rows if row['kind']=='actual-write-transition');transition['after']={key:transition['after'][key] for key in ['bytes','sha256']}
   if field in ['position','offset']:window['position']=window['offset']=value
   elif field=='count':next(row for row in rows if row['kind']=='kernel-syscall' and row.get('op')=='entry')['args'][2]=value
   else:transition['result']=value;next(row for row in rows if row['kind']=='kernel-syscall' and row.get('op')=='exit')['result']=value
   with self.subTest(field=field,value=value),self.assertRaises(ValueError):m.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,_:originals[name],{})
if __name__=='__main__':unittest.main()
