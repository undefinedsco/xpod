"""Failure diagnostics only; these tests never claim ptrace/all-stop authority."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('alias_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');backend=importlib.util.module_from_spec(spec);spec.loader.exec_module(backend)
class Tests(unittest.TestCase):
    def run_conflict(self, selected_flags, aliases):
        base=ROOT/'.test-data/sdk-writer-diagnostics';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            target=Path(directory)/'actual-input';target.write_bytes(b'actual-input-17')
            item=target.stat();held=os.open(target,os.O_RDONLY);observer=object.__new__(backend.Observer);observer.maximum_file_bytes=512*1024*1024;observer.shared_tasks=False
            observer.tasks={pid:dict(exited=False,entry={'sequence':13}) for pid,_ in aliases};observer.tasks.setdefault(101,dict(exited=False,entry={'sequence':13}))
            observer.barrier=lambda:{'sequence':17};observer.check=lambda:None;rows=[]
            observer.emit=lambda row:rows.append(dict(row,sequence=19)) or rows[-1]
            flags={(101,3):selected_flags,**aliases};stderr=io.StringIO()
            def listing(path):return [str(fd) for pid,fd in flags if path=='/proc/'+str(pid)+'/fd']
            with patch.object(backend,'fdpath',return_value=str(target)),patch.object(backend,'descriptor_flags',side_effect=lambda p,f:flags[p,f]),patch.object(observer,'bounded_fd_slots',side_effect=lambda pid:listing('/proc/'+str(pid)+'/fd')),patch.object(backend.os,'stat',return_value=item),patch.object(backend.os,'open',return_value=os.dup(held)),contextlib.redirect_stderr(stderr):
                with self.assertRaisesRegex(AssertionError,'live writable alias before consumer'):observer.capture(101,3,'consumer-before')
            os.close(held);self.assertEqual(len(rows),1);row=rows[0]
            self.assertEqual(row['identity'][:2],[item.st_dev,item.st_ino] if isinstance(row['identity'],list) else (item.st_dev,item.st_ino))
            self.assertEqual(row['path'],str(target));self.assertEqual(row['barrierSequence'],17)
            raw=stderr.getvalue();self.assertTrue(raw.startswith('SDK_INPUT_CAPTURE_CONFLICT '));self.assertLessEqual(len(raw.encode()),16420)
            self.assertEqual(json.loads(raw.split(' ',1)[1])['aliasCount'],row['aliasCount']);return row
    def test_selected_readwrite_is_identified_without_allowing_it(self):
        row=self.run_conflict(os.O_RDWR,{(101,3):os.O_RDWR})
        self.assertEqual(row['selectedFlags'],os.O_RDWR);self.assertEqual(row['aliases'],[dict(pid=101,fd=3,flags=os.O_RDWR,accessMode=os.O_RDWR)])
    def test_other_process_alias_is_distinct_and_samples_bounded(self):
        row=self.run_conflict(os.O_RDONLY,{(202,fd):os.O_RDWR for fd in range(40)})
        self.assertEqual(row['selectedFlags'],os.O_RDONLY);self.assertEqual(row['aliasCount'],40);self.assertEqual(len(row['aliases']),32);self.assertTrue(row['aliasesTruncated']);self.assertEqual(len(row['aliasInventorySha256']),64)
if __name__=='__main__':unittest.main()
