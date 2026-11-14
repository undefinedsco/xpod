"""Producer byte accounting only, never admission/issuer tests."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('capture_shared',ROOT/'scripts/lib/module-source-materials.py');capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
class SharedBudget(unittest.TestCase):
    def test_tar_and_inventory_actual_bytes_are_claimed_before_write(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            output=Path(temporary);source=output/'input';source.mkdir();file=source/'actual';file.write_bytes(b'actual-original');materials=output/'materials';materials.mkdir();claimed=[0]
            def reserve(count):
                existing=sum(p.stat().st_size for p in materials.iterdir());self.assertLessEqual(existing,claimed[0]);claimed[0]+=count
            capture.capture_group(materials,output,'source',[('actual',file)],source,reserve_bytes=reserve)
            self.assertEqual(claimed[0],sum(p.stat().st_size for p in materials.iterdir()))
            self.assertGreater(claimed[0],10240)
    def test_shared_exhaustion_rejects_tar_or_inventory_before_excess_bytes(self):
        for maximum in [0,10240]:
            with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
                output=Path(temporary);file=output/'actual';file.write_bytes(b'x');materials=output/'materials';materials.mkdir();claimed=[0]
                def reserve(count):
                    if claimed[0]+count>maximum:raise ValueError('shared actual byte budget')
                    claimed[0]+=count
                with self.assertRaisesRegex(ValueError,'shared actual byte budget'):capture.capture_group(materials,output,'source',[('actual',file)],output,reserve_bytes=reserve)
                self.assertLessEqual(sum(p.stat().st_size for p in materials.iterdir()),maximum)
    def test_writer_reservation_failure_never_calls_underlying_write(self):
        class Destination:
            name = str(ROOT / '.test-data' / 'unwritten')
            writes = []
            def write(self, data):
                self.writes.append(data)
                return len(data)
        destination = Destination()
        def reject(count):
            raise ValueError('shared actual byte budget')
        writer = capture.GuardedWriter(destination, 1024, reject)
        with self.assertRaisesRegex(ValueError, 'shared actual byte budget'):
            writer.write(b'original')
        self.assertEqual(destination.writes, [])
    def test_two_groups_share_one_nonrenewable_budget(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.test-data') as temporary:
            output = Path(temporary); file = output / 'actual'; file.write_bytes(b'x')
            materials = output / 'materials'; materials.mkdir(); charged = [0]
            def reserve(count):
                if charged[0] + count > 15000:
                    raise ValueError('shared actual byte budget')
                charged[0] += count
            capture.capture_group(materials, output, 'source', [('actual', file)], output, reserve_bytes=reserve)
            with self.assertRaisesRegex(ValueError, 'shared actual byte budget'):
                capture.capture_group(materials, output, 'toolchain', [('actual', file)], output, reserve_bytes=reserve)
            self.assertLessEqual(sum(p.stat().st_size for p in materials.iterdir()), 15000)
    def input_fixture(self, base):
        repo=base/'repo';output=base/'output';repo.mkdir();output.mkdir();(repo/'node_modules/example').mkdir(parents=True);(repo/'main.ts').write_bytes(b'actual source');(repo/'node_modules/example/index.js').write_bytes(b'actual dependency')
        tools=base/'tools';tools.mkdir()
        for name in ['bun','node','python3','git']:(tools/name).write_bytes(('actual tiny '+name).encode())
        return repo,output,tools
    def test_nonempty_capture_outputs_default_and_shared_full_ledger(self):
        for use_budget in [False,True]:
            with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
                repo,output,tools=self.input_fixture(Path(temporary));claimed=[0]
                def reserve(count):claimed[0]+=count
                callback=reserve if use_budget else None
                with patch.object(capture,'dependency_paths',return_value=['node_modules/example/index.js']),patch.object(capture.shutil,'which',side_effect=lambda name:str(tools/name)),patch.object(capture.subprocess,'check_output',return_value=b'tiny tool version'):
                    inputs=capture.capture_inputs(repo,output,['main.ts'],reserve_bytes=callback)
                    stage=output/'stage';stage.mkdir();(stage/'entry.mjs').write_bytes(b'actual generated output')
                    result=capture.capture_outputs(repo,output,inputs,[],{'path':'product.tgz'},reserve_bytes=callback)
                collection=json.loads((output/result['path']).read_text());self.assertEqual(len(collection['outputs']),1)
                rows=json.loads((output/collection['outputs'][0]['path']).read_text());self.assertEqual(rows[0]['path'],'entry.mjs')
                if use_budget:self.assertEqual(claimed[0],sum(p.stat().st_size for p in (output/'source-materials').iterdir()))
    def test_outputs_budget_exhaustion_prevents_inventory_and_final_metadata(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            repo,output,tools=self.input_fixture(Path(temporary))
            with patch.object(capture,'dependency_paths',return_value=['node_modules/example/index.js']),patch.object(capture.shutil,'which',side_effect=lambda name:str(tools/name)),patch.object(capture.subprocess,'check_output',return_value=b'tiny tool version'):
                inputs=capture.capture_inputs(repo,output,['main.ts']);stage=output/'stage';stage.mkdir();(stage/'entry.mjs').write_bytes(b'actual output')
                before={p.name:p.read_bytes() for p in (output/'source-materials').iterdir()}
                def reject(count):raise ValueError('shared exhausted before write')
                with self.assertRaisesRegex(ValueError,'shared exhausted before write'):capture.capture_outputs(repo,output,inputs,[],{},reserve_bytes=reject)
                self.assertEqual({p.name:p.read_bytes() for p in (output/'source-materials').iterdir()},before)
    def test_final_output_metadata_is_reserved_before_open(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            repo,output,tools=self.input_fixture(Path(temporary))
            with patch.object(capture,'dependency_paths',return_value=['node_modules/example/index.js']),patch.object(capture.shutil,'which',side_effect=lambda name:str(tools/name)),patch.object(capture.subprocess,'check_output',return_value=b'tiny tool version'):
                inputs=capture.capture_inputs(repo,output,['main.ts']);stage=output/'stage';stage.mkdir();(stage/'entry.mjs').write_bytes(b'actual output');calls=[0]
                def reserve(count):
                    calls[0]+=1
                    if calls[0]==5:raise ValueError('final metadata exhausted')
                with self.assertRaisesRegex(ValueError,'final metadata exhausted'):capture.capture_outputs(repo,output,inputs,[],{},reserve_bytes=reserve)
                self.assertTrue((output/'source-materials/outputs-0000.json').exists());self.assertFalse((output/'source-materials/materials.json').exists())
    def test_default_contract_is_unchanged(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as temporary:
            output=Path(temporary);file=output/'actual';file.write_bytes(b'x');materials=output/'materials';materials.mkdir()
            result=capture.capture_group(materials,output,'source',[('actual',file)],output)
            self.assertEqual(len(result['archives']),1);self.assertEqual(len(result['inventories']),1)
if __name__=='__main__':unittest.main()
