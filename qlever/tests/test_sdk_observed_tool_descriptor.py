"""Exact collection descriptor is a raw reference projection, not authority."""
import importlib.util
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tool_descriptor',ROOT/'qlever/scripts/sdk-ptrace-execution.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class Tests(unittest.TestCase):
 def test_first_capture_exact_raw_projection_no_cross_phase_repeat(self):
  o=b.Observer('/unused','/unused','/unused',shared_tasks=True,capture_toolchain=True);o.capture_dir=Path('/owned/captures');identity=[44,99,0o100755,3,11,12];ref=dict(path='capture-0000.original',bytes=3,sha256='a'*64)
  o.captures=[dict(kind='toolchain-original',captureKind='file',observedPath='/usr/bin/tool (deleted)',identity=identity,original=ref,phase='configure',sequence=17),dict(kind='toolchain-original',captureKind='maps',original=ref,phase='configure',sequence=18)]
  row=o.observed_tool_files(0,'configure')[0]
  self.assertEqual(row,dict(actualOriginalPath='/usr/bin/tool (deleted)',identity=identity,actualMode=identity[2],sourceKind='actual-tool-file-fd-snapshot',role='observed-tool-file',phase='configure',rawEventKind='toolchain-original',captureSequence=17,original=dict(ref,path='/owned/captures/capture-0000.original')))
  self.assertEqual(o.observed_tool_files(2,'compile'),[])
  with self.assertRaisesRegex(AssertionError,'another phase'):o.observed_tool_files(0,'compile')
if __name__=='__main__':unittest.main()
