"""Listener mechanics and protocol rejection only; never an issued SDK/product cap."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('probe',ROOT/'scripts/lib/inngest-runtime-probe.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
class Protocol(unittest.TestCase):
    def test_listener_requires_owned_pid_and_exact_loopback_socket(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as folder:
            root=Path(folder);(root/'net').mkdir();(root/'net/tcp').write_text('header\n0: 0100007F:3039 00000000:0000 0A 0 0 0 0 0 345\n')
            for pid in [10,11]:(root/str(pid)/'fd').mkdir(parents=True)
            (root/'10/fd/3').symlink_to('socket:[345]')
            self.assertEqual(probe.listener_owner(12345,{10:'actual-start'},lambda:None,root),dict(pid=10,inode='345',port=12345))
            with self.assertRaisesRegex(ValueError,'owned'):probe.listener_owner(12345,{11:'other-start'},lambda:None,root)
            (root/'11/fd/4').symlink_to('socket:[345]')
            with self.assertRaisesRegex(ValueError,'uniquely'):probe.listener_owner(12345,{10:'a',11:'b'},lambda:None,root)
    def test_expired_does_not_start_command(self):
        class Runner:
            deadline=probe.time.monotonic()-1
            def gate(self):pass
            def command(self,*args):raise AssertionError('expired must not start command')
        # Deadline is checked before any child can execute.
        with self.assertRaisesRegex(ValueError,'deadline'):probe.protocol(Runner(),'node',[],Path('/fixed'),{},Path('/owned'))
    def test_http_failure_and_nonresponse_do_not_issue_protocol(self):
        class Process:
            returncode=None
            def poll(self):return None
            def wait(self,timeout):self.returncode=0
        class Runner:
            deadline=None
            def gate(self):pass
            def observe_group(self,process):return {42:'owned-start'}
            def command(self,label,argv,env,cycle,callback):callback(Process())
        class Response:
            status=200
            def read(self,maximum):return b'{"status":200,"message":"WRONG"}'
        class Connection:
            def __init__(self,*args,**kwargs):pass
            def request(self,*args,**kwargs):pass
            def getresponse(self):return Response()
            def close(self):pass
        def owner(port,*args):return dict(pid=42,inode='123',port=port)
        with patch.object(probe,'listener_owner',side_effect=owner),patch.object(probe.http.client,'HTTPConnection',Connection),patch.object(probe.os,'kill') as kill:
            with self.assertRaisesRegex(ValueError,'health response'):probe.protocol(Runner(),'node',[],Path('/fixed'),{},Path('/owned'))
            kill.assert_not_called()
        # A server which never answers consumes the same 30s window; fake clock
        # advances that window after the first actual timeout, no second budget.
        ticks=[0]
        def clock():ticks[0]+=16;return ticks[0]
        class NoResponse(Connection):
            def getresponse(self):raise TimeoutError('no response')
        with patch.object(probe,'listener_owner',side_effect=owner),patch.object(probe.http.client,'HTTPConnection',NoResponse),patch.object(probe.time,'monotonic',side_effect=clock):
            with self.assertRaisesRegex(ValueError,'deadline'):probe.protocol(Runner(),'node',[],Path('/fixed'),{},Path('/owned'))
if __name__=='__main__':unittest.main()
