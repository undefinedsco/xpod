"""Tiny real filesystem producer mechanics; no compiler/capability issuance."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('controlled',ROOT/'scripts/lib/inngest-controlled-build.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
class Controlled(unittest.TestCase):
    def test_explicit_plan_one_clipped_window_no_nested_supervisor(self):
        plan=build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan','linux-arm64',build.POLICY['sourceKind'])
        self.assertEqual(len(plan),11);self.assertEqual(len(set(p[0] for p in plan)),11)
        self.assertEqual(build.native_deadline(100,90),100);self.assertEqual(build.native_deadline(5000,90),1890)
        for target,kind in [('windows-x64',build.POLICY['sourceKind']),('linux-arm64','official-release')]:
            with self.assertRaises(ValueError):build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan',target,kind)
        clipped=build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan','linux-arm64',build.POLICY['sourceKind'],12345);self.assertEqual(clipped[0][1][-2:],['--retained-byte-ceiling','12345'])
        with self.assertRaises(ValueError):build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan','linux-arm64',build.POLICY['sourceKind'],build.LIMITS['sourceMaterialBytes']+1)
        self.assertIn('-mod=vendor',plan[-2][1]);self.assertIn('--ignore-scripts',plan[5][1]);self.assertFalse(any('supervise' in str(p[1]) for p in plan))
    def test_all_native_targets_keep_same_phases_and_target_scoped_tools(self):
        for target,descriptor in build.POLICY['targetDescriptors'].items():
            plan=build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan',target,build.POLICY['sourceKind'],123)
            self.assertEqual(len(plan),11);self.assertEqual([p[0] for p in plan],list(build.phase_plan(ROOT,ROOT/'.test-data/controlled-plan','linux-arm64',build.POLICY['sourceKind'])[i][0] for i in range(11)))
            for _,argv,_,_ in plan:
                if str(ROOT/'scripts/lib/inngest-controlled-build.py') in argv:self.assertEqual(argv[argv.index('--target')+1],target)
            env=build.environment(ROOT/'.test-data/controlled-plan',target);self.assertEqual(env['GOOS'],descriptor['goos']);self.assertEqual(env['GOARCH'],descriptor['goarch']);self.assertEqual(env['CGO_ENABLED'],'0');self.assertFalse('GOARM64' in env and 'GOAMD64' in env)
            self.assertEqual(set(build.target_tools(target)),{'go','node','pnpm'})
    def test_actual_host_mismatch_refused_before_tool_execution(self):
        import types
        with patch.object(build.sys,'platform','linux'),patch.object(build.os,'uname',return_value=types.SimpleNamespace(machine='aarch64')):
            build.require_host('linux-arm64')
            for target in ['linux-x64','darwin-arm64','darwin-x64']:
                with self.assertRaisesRegex(ValueError,'matching native'):build.require_host(target)
        with patch.object(build.sys,'platform','linux'),patch.object(build.os,'uname',return_value=types.SimpleNamespace(machine='x86_64')):build.require_host('linux-x64')
    def test_all_binary_headers_reject_cross_target_products(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            file=Path(temporary)/'binary'
            for target,descriptor in build.POLICY['targetDescriptors'].items():
                header=bytearray(64);kind=descriptor['binaryFormat']
                if kind['format']=='elf64-le':header[:6]=b'\x7fELF\x02\x01';header[18:20]=kind['machine'].to_bytes(2,'little')
                else:header[:4]=(0xfeedfacf).to_bytes(4,'little');header[4:8]=kind['cpuType'].to_bytes(4,'little')
                file.write_bytes(header);build.verify_binary_target(file,target)
                for other in build.POLICY['targetDescriptors']:
                    if other!=target:
                        with self.assertRaises(ValueError):build.verify_binary_target(file,other)
    def make(self,work):
        for p in ['source/node_modules/example','tools/go','originals','products']:(work/p).mkdir(parents=True,exist_ok=True)
        (work/'source/main.go').write_bytes(b'package main');(work/'source/node_modules/example/index.js').write_bytes(b'dependency');(work/'tools/go/go').write_bytes(b'tool');(work/'source/LICENSE.md').write_bytes(b'actual source terms')
    def test_capture_full_actual_domains_and_reject_changed_dependency(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            work=Path(temporary);self.make(work);build.capture_inputs(work)
            collection=json.loads((work/'inputs.original.json').read_text());self.assertEqual(set(collection['originals']),{'source','dependencies','toolchain'})
            deps=build.loaded_rows(work,collection['originals']['dependencies']);self.assertIn('node_modules/example/index.js',deps)
            (work/'source/node_modules/example/index.js').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'dependencies/tool originals changed'):build.finalize(work)
    def test_fixed_acquisition_retains_actual_bytes_and_rejects_redirect_or_growth(self):
        import io
        class Response(io.BytesIO):
            status=200;headers={}
            def geturl(self):return 'https://example.invalid/fixed'
        class Opener:
            def __init__(self,payload,url=None):self.payload,self.url=payload,url
            def open(self,request,timeout):
                result=Response(self.payload)
                if self.url:result.geturl=lambda:self.url
                return result
        pin={'file':'fixed.tar','bytes':3,'sha256':build.hashlib.sha256(b'abc').hexdigest(),'url':'https://example.invalid/fixed'}
        for payload,url,accepted in [(b'abc',None,True),(b'abc','https://example.invalid/redirected',False),(b'abcd',None,False)]:
            with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
                work=Path(temporary)
                with patch.dict(build.POLICY,{'source':pin}),patch.object(build,'target_tools',return_value={}),patch.object(build.urllib.request,'build_opener',return_value=Opener(payload,url)):
                    if accepted:
                        build.acquire(work);self.assertEqual((work/'originals/fixed.tar').read_bytes(),b'abc')
                        self.assertEqual(json.loads((work/'fixed.tar.http.original.json').read_text())['bytes'],3)
                    else:
                        with self.assertRaises(ValueError):build.acquire(work)
                        self.assertFalse((work/'originals/fixed.tar').exists())
    def test_prepare_retains_exact_acquisition_refs_without_executing_tools(self):
        import io,tarfile,types
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            work=Path(temporary);originals=work/'originals';originals.mkdir();pins=[]
            for filename,prefix,member in [('source.tgz','inngest-inngest-'+build.POLICY['sourceCommit'][:7],'LICENSE.md'),('go.tgz','go','bin/go')]:
                file=originals/filename
                with tarfile.open(file,'w:gz') as archive:
                    data=b'actual tiny source or tool original';info=tarfile.TarInfo(prefix+'/'+member);info.size=len(data);archive.addfile(info,io.BytesIO(data))
                pin={'file':filename,'bytes':file.stat().st_size,'sha256':build.sha(file),'prefix':prefix,'url':'https://fixture.invalid/'+filename};pins.append(pin)
                (work/(filename+'.http.original.json')).write_text(json.dumps({'url':pin['url'],'status':200,'bytes':pin['bytes'],'sha256':pin['sha256']}))
            with patch.dict(build.POLICY,{'source':pins[0]}),patch.object(build,'target_tools',return_value={'go':pins[1]}),patch.object(build.sys,'platform','linux'),patch.object(build.os,'uname',return_value=types.SimpleNamespace(machine='aarch64')):
                build.prepare(work)
            preparation=json.loads((work/'preparation.original.json').read_text());self.assertEqual(len(preparation['acquisitionOriginals']),2)
            for reference in preparation['acquisitionOriginals']:self.assertEqual(build.sha(work/reference['path']),reference['sha256'])
            self.assertEqual((work/'source/LICENSE.md').read_bytes(),b'actual tiny source or tool original')
    def test_ui_build_outputs_are_actual_go_embedded_inputs(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            work=Path(temporary);dist=work/'source/ui/apps/dev-server-ui/dist';static=work/'source/pkg/devserver/static';dist.mkdir(parents=True);static.mkdir(parents=True)
            (dist/'index.html').write_bytes(b'actual built UI');(static/'index.html').write_bytes(b'old source UI')
            build.materialize_ui(work);self.assertEqual((static/'index.html').read_bytes(),b'actual built UI')
            (dist/'linked').symlink_to('index.html')
            with self.assertRaisesRegex(ValueError,'ordinary actual UI outputs'):build.materialize_ui(work)
    def test_shared_budget_rejects_inventory_before_file_creation(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            work=Path(temporary);self.make(work);budget=build.MaterialBudget(work)
            with patch.dict(build.LIMITS,{'sourceMaterialBytes':budget.charged+1}):
                with self.assertRaisesRegex(ValueError,'shared retained'):build.write_metadata(work/'unwritten.json',{'not':'written'},budget)
            self.assertFalse((work/'unwritten.json').exists())
    def test_final_generated_diff_preserves_removed_and_changes_without_recapturing_deps(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            work=Path(temporary);self.make(work);(work/'preparation.original.json').write_text('{}');(work/'source/removed').write_bytes(b'old');build.capture_inputs(work)
            (work/'source/main.go').write_bytes(b'generated compiler input');(work/'source/removed').unlink();(work/'source/generated').write_bytes(b'new');header=bytearray(64);header[:6]=b'\x7fELF\x02\x01';header[18:20]=(183).to_bytes(2,'little');(work/'products/inngest').write_bytes(header);(work/'products/inngest').chmod(0o755)
            for pin in [build.POLICY['source'],*build.target_tools('linux-arm64').values()]:(work/'originals'/pin['file']).write_bytes(b'tiny fixture original')
            # No trust is issued; fixture pins replace only transport verification.
            with patch.object(build,'verify_original',return_value=None):build.finalize(work)
            result=json.loads((work/'controlled-build-materials.json').read_text());self.assertEqual(result['generated']['changedCount'],2);self.assertEqual(result['generated']['removedCount'],1)
            self.assertEqual(json.loads((work/result['generated']['removedOriginals'][0]['path']).read_text()),['removed'])
            self.assertEqual(build.loaded_rows(work,result['generated']['originals'])['generated']['sha256'],build.sha(work/'source/generated'))
            self.assertNotIn('officialArchiveSHA256',result)
if __name__=='__main__':unittest.main()
