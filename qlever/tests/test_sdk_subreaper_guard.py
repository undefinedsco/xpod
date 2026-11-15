"""Pure control-path regression tests; these do not assert Linux/PID1 behavior."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import ExitStack
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('guard_control_tests',ROOT/'qlever/scripts/sdk-subreaper-guard.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class GuardControlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):(ROOT/'.test-data/sdk-subreaper-guard').mkdir(parents=True,exist_ok=True)
    def controlled(self,stack,handlers):
        stack.enter_context(patch.object(module.sys,'platform','linux'))
        stack.enter_context(patch.object(module.os,'getpid',return_value=1))
        stack.enter_context(patch.object(module.os,'getpgrp',return_value=1))
        stack.enter_context(patch.object(module.os,'readlink',return_value='pid:[fixture-only]'))
        stack.enter_context(patch.object(module.os,'pidfd_open',create=True))
        stack.enter_context(patch.object(module.os,'P_PIDFD',3,create=True))
        stack.enter_context(patch.object(module.signal,'pidfd_send_signal',create=True))
        stack.enter_context(patch.object(module.ctypes,'CDLL',return_value=SimpleNamespace(prctl=lambda *args:0)))
        stack.enter_context(patch.object(module.signal,'signal',side_effect=lambda sig,handler:handlers.update({sig:handler})))
        stack.enter_context(patch.object(module,'children',return_value=[]))
        stack.enter_context(patch.object(module.subprocess,'Popen',return_value=SimpleNamespace(pid=42,poll=lambda:0,returncode=0)))
    def test_mocked_cleanup_failure_does_not_allocate_second_grace(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-subreaper-guard') as directory, ExitStack() as stack:
            self.controlled(stack,{})
            cleanup=stack.enter_context(patch.object(module,'terminate_owned',side_effect=TimeoutError('same deadline')))
            receipt=Path(directory)/'fixture-only.json';code=module.run(['fixture'],receipt,time.time()+10,3)
            self.assertEqual(code,1);self.assertEqual(cleanup.call_count,1)
            value=json.loads(receipt.read_text());self.assertIsNone(value['cleanup'])
            self.assertIn('same deadline',value['error'])
    def test_mocked_term_during_cleanup_after_poll_zero_is_failure(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-subreaper-guard') as directory, ExitStack() as stack:
            handlers={};self.controlled(stack,handlers)
            def cleanup(deadline):
                handlers[signal.SIGTERM](signal.SIGTERM,None)
                return dict(reaped=[],signalledPidfds=[],actualEchild=True)
            stack.enter_context(patch.object(module,'terminate_owned',side_effect=cleanup))
            receipt=Path(directory)/'fixture-only.json';self.assertEqual(module.run(['fixture'],receipt,time.time()+10,3),1)
            value=json.loads(receipt.read_text());self.assertEqual(value['reason'],'guard-interrupted')
            self.assertEqual(value['topCommandReturnCode'],0);self.assertEqual(value['observedSignals'],[signal.SIGTERM])
    def test_continuous_reap_checks_same_deadline_per_wait(self):
        with patch.object(module.time,'monotonic',side_effect=[0,1,2,3]), patch.object(module.os,'waitpid',return_value=(42,0)) as wait:
            with self.assertRaises(TimeoutError):module.reap(3)
            self.assertEqual(wait.call_count,3)
    def test_non_pid1_refused_before_any_command(self):
        with patch.object(module.os,'getpid',return_value=99), patch.object(module.subprocess,'Popen') as command:
            with self.assertRaisesRegex(RuntimeError,'PID namespace init'):module.run(['fixture'],'unused',time.time()+10)
            command.assert_not_called()

if __name__=='__main__':unittest.main()
