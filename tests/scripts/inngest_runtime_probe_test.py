import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('inngest_probe',ROOT/'scripts/lib/inngest-runtime-probe.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
class TestSnapshot(unittest.TestCase):
    def fixture(self,path,machine=62):
        body=bytearray(128);body[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',body,18,machine);struct.pack_into('<Q',body,32,64);struct.pack_into('<HH',body,54,56,1);struct.pack_into('<I',body,64,1);path.write_bytes(body);path.chmod(0o755);return body
    def test_actual_fd_full_hash_and_static_target(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as root:
            p=Path(root)/'synthetic-elf'
            for machine,target in [(62,'linux-x64'),(183,'linux-arm64')]:
                b=self.fixture(p,machine);value=probe.snapshot(p,hashlib.sha256(b).hexdigest(),target,lambda:None);self.assertEqual(value['loader'],{'format':'elf64','interpreter':False,'neededLibraries':[]});self.assertEqual(value['bytes'],128)
    def test_growth_wrong_target_and_loader_refused(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as root:
            p=Path(root)/'synthetic-elf';b=self.fixture(p)
            def grow():
                with p.open('ab') as out:out.write(b'growth')
            with self.assertRaises(ValueError):probe.snapshot(p,hashlib.sha256(b).hexdigest(),'linux-x64',grow)
            b=self.fixture(p)
            with self.assertRaises(ValueError):probe.snapshot(p,hashlib.sha256(b).hexdigest(),'linux-arm64',lambda:None)
            struct.pack_into('<I',b,64,3);p.write_bytes(b)
            with self.assertRaises(ValueError):probe.snapshot(p,hashlib.sha256(b).hexdigest(),'linux-x64',lambda:None)
    def test_actual_macho_header_and_system_load_names_both_targets(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as root:
            p=Path(root)/'synthetic-macho'
            for cpu,target in [(0x01000007,'darwin-x64'),(0x0100000c,'darwin-arm64')]:
                name=b'/usr/lib/libSystem.B.dylib\0';size=(24+len(name)+7)//8*8
                body=bytearray(32+size);body[:4]=b'\xcf\xfa\xed\xfe';struct.pack_into('<I',body,4,cpu);struct.pack_into('<II',body,16,1,size);struct.pack_into('<III',body,32,0xc,size,24);body[56:56+len(name)]=name;p.write_bytes(body);p.chmod(0o755)
                value=probe.snapshot(p,hashlib.sha256(body).hexdigest(),target,lambda:None);self.assertEqual(value['loader']['libraries'],['/usr/lib/libSystem.B.dylib'])
    def test_fixed_new_commands_cannot_inherit_caller_long_timeout(self):
        spec=importlib.util.spec_from_file_location('api_driver',ROOT/'scripts/api-module-consumer.py');driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
        runner=driver.Runner.__new__(driver.Runner);runner.plan={'timeoutSeconds':600}
        self.assertEqual(runner.total_deadline_seconds(),720)
        self.assertEqual(runner.command_timeout_seconds('node-inngest-version'),30)
        self.assertEqual(runner.command_timeout_seconds('bun-inngest-loader'),30)
        self.assertEqual(runner.command_timeout_seconds('node-api-service'),600)
    def test_explicit_schema2_selector_uses_the_single_policy_without_granting_authority(self):
        import json
        policy=json.loads(probe.controlled_policy_file().read_text());sha='a'*64
        old={'schemaVersion':1,'platform':'linux','arch':'arm64','binarySHA256':sha}
        self.assertEqual(probe.installed_binary_expectation(old,'linux-arm64'),(sha,None))
        current={'schemaVersion':2,'sourceKind':policy['sourceKind'],'target':'linux-arm64','sourceCommit':policy['sourceCommit'],'binary':{'path':'node_modules/inngest-cli/bin/inngest','bytes':128,'sha256':sha}}
        self.assertEqual(probe.installed_binary_expectation(current,'linux-arm64'),(sha,128))
        for changed in [{**current,'sourceKind':'official-release'},{**current,'target':'linux-x64'},{**current,'sourceCommit':'b'*40},{**current,'binary':{**current['binary'],'path':'elsewhere'}},{**current,'binary':{**current['binary'],'bytes':True}},{**current,'schemaVersion':3}]:
            with self.assertRaises(ValueError):probe.installed_binary_expectation(changed,'linux-arm64')
    def test_single_budget_authority_includes_hash_passes(self):self.assertEqual(probe.additional_seconds(),240)
if __name__=='__main__':(ROOT/'.test-data').mkdir(exist_ok=True);unittest.main()
