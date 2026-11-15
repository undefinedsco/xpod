"""Lossless raw storage, bounded independently from execution semantics."""
import importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('raw_codec',Path(__file__).resolve().parents[1]/'scripts/sdk-execution-originals-util.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_exact_values_and_order(self):
  rows=[dict(kind='entry',sequence=1,integer=2**64-1,nested={'text':'汉字\n','list':[None,False,1.25]}),dict(kind='exit',sequence=2,integer=-2**63,nested={}),dict(other='schema',sequence=3)]
  encoder=m.IndexedRawEncoder();lines=[line for row in rows for line in encoder.encode(row)]
  self.assertEqual(list(m.decoded_raw_records(lines)),rows)
  self.assertEqual(sum(json.loads(line)[0]=='schema'for line in lines),2)
 def test_legacy(self):
  rows=[dict(kind='entry',sequence=1),dict(kind='exit',sequence=2)]
  self.assertEqual(list(m.decoded_raw_records([(json.dumps(row)+'\n').encode()for row in rows])),rows)
 def test_malformed_streams(self):
  header=[m.RAW_RECORD_MODEL]
  cases=[[header],[header,['schema',0,['a']]],[header,['schema',True,['a']]],[header,['schema',1,['a']]],[header,['schema',0,['b','a']]],[header,['schema',0,['a','a']]],[header,['row',0,[1]]],[header,['schema',0,['a']],['row',0,[]]],[header,['schema',0,['a']],['schema',1,['b']]],[header,['schema',0,['a']],['row',0,[1]],['schema',1,['a']]],[header,{'kind':'mixed'}],[{'kind':'legacy'},header]]
  for values in cases:
   with self.subTest(values=values),self.assertRaises((AssertionError,ValueError,TypeError)):
    list(m.decoded_raw_records([(json.dumps(value)+'\n').encode()for value in values]))
 def test_decoded_size_bound(self):
  row={'x'*128:'a'*65400}
  self.assertGreater(len((json.dumps(row,sort_keys=True)+'\n').encode()),65536)
  with self.assertRaises(AssertionError):m.IndexedRawEncoder().encode(row)
  lines=[[m.RAW_RECORD_MODEL],['schema',0,list(row)],['row',0,list(row.values())]]
  with self.assertRaises(AssertionError):list(m.decoded_raw_records([(json.dumps(value,separators=(',',':'))+'\n').encode()for value in lines]))
 def test_schema_count_bound(self):
  encoder=m.IndexedRawEncoder()
  for index in range(256):encoder.encode({str(index):index})
  with self.assertRaises(AssertionError):encoder.encode({'overflow':0})
if __name__=='__main__':unittest.main()
