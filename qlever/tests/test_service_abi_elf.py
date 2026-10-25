import importlib.util
from pathlib import Path
import struct
import unittest
spec=importlib.util.spec_from_file_location('elf',Path(__file__).resolve().parents[1]/'scripts/sdk-service-abi-elf.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def image(interp=None):
 b=bytearray(512);b[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HHI',b,16,2,183,1);struct.pack_into('<Q',b,32,64);struct.pack_into('<HHH',b,52,64,56,1)
 struct.pack_into('<IIQQQQQQ',b,64,1 if interp is None else 3,0,256,0,0,0 if interp is None else len(interp),0,0)
 if interp:b[256:256+len(interp)]=interp
 return bytes(b)
def inspect(b,check=lambda:None):return m.inspect_elf_loader(lambda o,n:b[o:o+n],len(b),check)
class Tests(unittest.TestCase):
 def test_actual_complete_static_and_dynamic(self):
  self.assertEqual(inspect(image()),{'kind':'static','machine':183})
  self.assertEqual(inspect(image(b'/lib/ld-linux-aarch64.so.1\0'))['interpreter'],'/lib/ld-linux-aarch64.so.1')
 def test_unsafe_interp_and_header_fail(self):
  for value in [b'relative\0',b'/lib/../bad\0',b'/lib//bad\0',b'/lib/a\0b\0',b'/lib/a',b'/lib/\n\0']:
   with self.subTest(value=value),self.assertRaises(ValueError):inspect(image(value))
  for off,value in [(4,1),(5,2),(6,0),(52,63),(54,55)]:
   b=bytearray(image());b[off]=value
   with self.subTest(off=off),self.assertRaises(ValueError):inspect(bytes(b))
 def test_count_truncation_duplicate_and_cancel(self):
  b=bytearray(image());struct.pack_into('<H',b,56,65535)
  with self.assertRaises(ValueError):inspect(bytes(b))
  b=bytearray(image(b'/lib/ld.so\0'));struct.pack_into('<H',b,56,2);b[120:176]=b[64:120]
  with self.assertRaises(ValueError):inspect(bytes(b))
  with self.assertRaises(ValueError):m.inspect_elf_loader(lambda o,n:b'',512,lambda:None)
  error=RuntimeError('stop')
  def check():raise error
  try:inspect(image(),check)
  except RuntimeError as caught:self.assertIs(caught,error)
  else:self.fail('cancel swallowed')
if __name__=='__main__':unittest.main()
