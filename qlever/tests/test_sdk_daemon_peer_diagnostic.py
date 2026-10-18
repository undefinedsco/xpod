import ast
from pathlib import Path
import types
import unittest
from unittest.mock import patch, mock_open

SOURCE=Path(__file__).parents[1]/'scripts/sdk-readonly-executor.py'
class Diagnostic(unittest.TestCase):
    def sample(self,executable):
        tree=ast.parse(SOURCE.read_text());node=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='LocalDaemon')
        def need(ok,message):
            if not ok:raise ValueError(message)
        identity=types.SimpleNamespace(st_dev=1,st_ino=2,st_mode=3,st_size=4,st_mtime_ns=5,st_ctime_ns=6)
        fakeos=types.SimpleNamespace(readlink=lambda p:executable if p.endswith('/exe') else 'pid:[1]',stat=lambda p:identity,fstat=lambda p:identity)
        fakepoll=types.SimpleNamespace(register=lambda *a:None,poll=lambda *a:[])
        env={'os':fakeos,'select':types.SimpleNamespace(poll=lambda:fakepoll,POLLIN=1),'binding':types.SimpleNamespace(need=need)}
        exec(compile(ast.Module(body=[node],type_ignores=[]),str(SOURCE),'exec'),env)
        obj=object.__new__(env['LocalDaemon']);obj.pidfd=1;obj.exe=2;obj.pid=3;obj.uid=0;rows=[]
        with patch('builtins.open',mock_open(read_data=b'NSpid:\t3\n')):
            with self.assertRaisesRegex(ValueError,'unreviewed/proxy Docker peer executable'):
                obj.sample(lambda:None,rows.append)
        return rows
    def test_unknown_actual_path_retained_but_rejected(self):
        rows=self.sample('/usr/local/bin/dockerd');self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['executablePath'],'/usr/local/bin/dockerd');self.assertFalse(rows[0]['authorityVerified'])
        self.assertEqual(rows[0]['heldExecutableIdentity'],rows[0]['namedExecutableIdentity'])
    def test_proxy_remains_rejected(self):self.assertEqual(self.sample('/usr/bin/proxy')[0]['executablePath'],'/usr/bin/proxy')
    def test_diagnostic_path_bound(self):
        with self.assertRaisesRegex(AssertionError,'bounded actual Docker peer executable path'):self.sample('/'+('x'*4096))
class ActualRouteDiagnostic(unittest.TestCase):
    def test_first_route_daemon_refusal_retains_diagnostic_before_any_command(self):
        import importlib.util,json,os,tempfile,time
        source=SOURCE.parent/'sdk-readonly-normal-route.py'
        spec=importlib.util.spec_from_file_location('route_peer_test',source);route=importlib.util.module_from_spec(spec);spec.loader.exec_module(route)
        identity=dict(sourceSha='a'*40,runHeadSha='a'*40,runId=12,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
        root=SOURCE.parents[2]/'.test-data/sdk-peer-route';root.mkdir(parents=True,exist_ok=True)
        calls=[]
        def refused(check,diagnose,*activation_contract):
            check();calls.append('first-daemon');diagnose({'authorityVerified':False,'executablePath':'/unreviewed/peer'})
            raise ValueError('unreviewed/proxy Docker peer executable')
        with tempfile.TemporaryDirectory(dir=root) as directory:
            directory=Path(directory).resolve();out=directory/'qlever-sdk-outer'
            with patch.dict(os.environ,{'RUNNER_TEMP':str(directory)}),patch.object(route.outer.platform,'system',return_value='Linux'),patch.object(route.os,'geteuid',return_value=0),patch.object(route.outer,'LocalDaemon',side_effect=refused),patch.object(route.outer.commands,'capture') as capture:
                with self.assertRaisesRegex(ValueError,'unreviewed/proxy Docker peer executable'):route.run(identity,time.time()+120,out,directory/'unused-source-context')
                capture.assert_not_called()
            self.assertEqual(calls,['first-daemon']);self.assertEqual(json.loads((out/'daemon-peer-diagnostic.original.json').read_text()),{'authorityVerified':False,'executablePath':'/unreviewed/peer'})
if __name__=='__main__':unittest.main()
