"""Rejection diagnostics over held-FD filesystem fixtures, not kernel claims."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

path=Path(__file__).with_name('test_sdk_setresuid_runtime.py')
spec=importlib.util.spec_from_file_location('stopped_difference_fixture',path)
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
provider=fixture.m

class Tests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixture.Tests('test_actual_file_descriptors_and_raw')
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)

    def changed_sample(self,key='voluntary_ctxt_switches',broken_output=False):
        observer=self.fixture.entry();read=observer._read;counts={'status':0,'stat':0}
        def changed(role,maximum):
            row=read(role,maximum);counts[role]+=1
            if role=='status':
                if key=='Gid' and counts[role]==2:
                    row['data']=row['data'].replace('Gid: 0 0 0 0','Gid: 0 0 0 1')
                elif key!='Gid':row['data']+='voluntary_ctxt_switches: '+str(counts[role])+'\nName: SECRET_VALUE_NEVER_PRINTED\n'
            elif counts[role]==2:
                words=row['data'].split();words[3]='1';row['data']=' '.join(words)+'\n'
            row['bytes']=len(row['data'].encode());row['sha256']=hashlib.sha256(row['data'].encode()).hexdigest()
            return row
        with patch.object(observer,'_read',side_effect=changed),patch.object(provider.sys.stderr,'write',side_effect=OSError('closed diagnostic') if broken_output else None) as output:
            with self.assertRaisesRegex(ValueError,'actual stopped authority changed during capture'):
                self.fixture.finish(observer)
        self.assertTrue(observer.closed)
        return output

    def test_real_sample_rejects_and_reports_field_names_not_values(self):
        output=self.changed_sample();self.assertEqual(output.call_count,1)
        text=output.call_args[0][0];self.assertLessEqual(len(text.encode()),4096)
        row=json.loads(text.split(' ',1)[1]);self.assertEqual(row['statusChangedKeys'],['voluntary_ctxt_switches'])
        self.assertEqual(row['statChangedFields'],[4]);self.assertFalse(row['authorityVerified'])
        self.assertNotIn('SECRET_VALUE_NEVER_PRINTED',text)
        self.assertEqual(len(row['statusOriginals']),2);self.assertEqual(len(row['statOriginals']),2)

    def test_actual_authority_change_is_still_rejected(self):
        row=json.loads(self.changed_sample('Gid').call_args[0][0].split(' ',1)[1])
        self.assertEqual(row['statusChangedKeys'],['Gid'])

    def test_broken_diagnostic_does_not_replace_original_rejection(self):
        self.changed_sample(broken_output=True)

    def test_stable_sample_never_emits_diagnostic(self):
        observer=self.fixture.entry()
        with patch.object(provider.sys.stderr,'write') as output:self.fixture.finish(observer)
        output.assert_not_called();self.assertTrue(observer.closed)

if __name__=='__main__':unittest.main()
