import importlib.util
from pathlib import Path
import signal
import tempfile
import time
import unittest
from unittest import mock
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('collection',HERE/'sdk-readonly-collection.py');collection=importlib.util.module_from_spec(spec);spec.loader.exec_module(collection)
class Budget:
    def check(self,*args):pass
    def remaining(self):return .03
class CollectionTest(unittest.TestCase):
    def test_shared_ledger_copy_preserves_actual_full_bytes_and_wrong_ref_rejects(self):
        base=HERE.parents[1]/'.test-data/sdk-readonly-collection';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory).resolve();source=root/'source';source.mkdir();(source/'original').write_bytes(b'actual-original');out=root/'out';out.mkdir();ledger=collection.Ledger(out,Budget());ref=ledger.ref(source/'original',source);ledger.copy(source,ref)
            self.assertEqual((out/'original').read_bytes(),b'actual-original');self.assertEqual(ledger.total,len(b'actual-original'));ledger.copy(source,ref);self.assertEqual(ledger.total,len(b'actual-original'))
            with self.assertRaises(ValueError):ledger.copy(source,dict(ref,sha256='0'*64))
            with self.assertRaises(ValueError):ledger.copy(source,dict(ref,path='../original'))
    def test_budget_rejects_before_metadata_file_open(self):
        base=HERE.parents[1]/'.test-data/sdk-readonly-collection';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);ledger=collection.Ledger(root,Budget());ledger.total=collection.limits['sourceMaterialBytes']-ledger.reserve
            with self.assertRaises(ValueError):ledger.write(root/'not-created.json',{'actual':'bytes'})
            self.assertFalse((root/'not-created.json').exists())
    def test_cleanup_uses_remaining_without_work_reserve_and_charges_before_open(self):
        class TailBudget:
            def check(self,reserve=0):
                if reserve>=25:raise TimeoutError('work reserve unavailable')
            def timeout(self,cap):return min(cap,25)
        base=HERE.parents[1]/'.test-data/sdk-readonly-collection';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=Path(directory);budget=TailBudget();ledger=collection.Ledger(root,budget);rows=[]
            row={key:dict(path=key+'.raw',bytes=1,sha256='0'*64) for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']}
            with mock.patch.object(collection.outer.commands,'capture',return_value=row) as capture:
                collection.cleanup_final_copy(root,budget,ledger,'sha256:'+'a'*64,'b'*64,123.0,rows)
            self.assertEqual(capture.call_args.kwargs['timeout'],25);self.assertEqual(rows,[row]);self.assertEqual(len(ledger.paths),6)
            other=root/'exhausted';other.mkdir();ledger=collection.Ledger(other,budget);ledger.total=collection.limits['sourceMaterialBytes']-ledger.reserve
            with mock.patch.object(collection.outer.commands,'capture') as capture:
                with self.assertRaises(ValueError):collection.cleanup_final_copy(other,budget,ledger,'sha256:'+'a'*64,'b'*64,123.0,[])
                capture.assert_not_called()
            self.assertFalse((other/'remove-final-copy.plan.json').exists())

    def test_absolute_parent_timer_interrupts_blocking_tail_and_restores_handler(self):
        previous=signal.getsignal(signal.SIGALRM);start=time.monotonic()
        with self.assertRaises(TimeoutError):
            with collection.absolute_budget(Budget()):time.sleep(.3)
        self.assertLess(time.monotonic()-start,.2);self.assertEqual(signal.getsignal(signal.SIGALRM),previous);self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0.0,0.0))
if __name__=='__main__':unittest.main()
