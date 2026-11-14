#!/usr/bin/env python3
"""SDK90 R2 proof: root-contained O_PATH metadata classification of write opens.

Real Linux child + real Observer + real raw replay.  A headless /dev/tty must
return its ordinary ENXIO without aborting configure, while a consumed regular
build input in the same phase still takes the unchanged generation handoff.
"""
import errno
import importlib.util
import os
import stat
import sys
import time
import traceback
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('metadata_e2e_factory', HERE / 'test_sdk70_mremap_e2e.py')
e2e = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = e2e
spec.loader.exec_module(e2e)

C = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static int wr(const char *path,const char *data,int size){
 int fd=open(path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
 if(fd<0)return 1;
 if(write(fd,data,size)!=size)return 2;
 return close(fd)?3:0;
}
static int rd(const char *path,char *data,int size){
 int fd=open(path,O_RDONLY|O_CLOEXEC);
 if(fd<0)return 4;
 int got=read(fd,data,size);
 if(close(fd))return 5;
 return got;
}
int main(int argc,char **argv){
 if(argc<2)return 90;
 const char *mode=argv[1];
 if(!strcmp(mode,"tty-regular")){
  const char *archive=argv[2];
  if(wr(archive,"!<arch>\n",8))return 10;
  errno=0;
  int tty=open("/dev/tty",O_WRONLY|O_NONBLOCK);
  int tty_enxio=(tty<0&&errno==ENXIO);
  fprintf(stderr,"TTY_ENXIO=%d\n",tty_enxio);
  if(tty>=0)close(tty);
  char bytes[8];
  if(rd(archive,bytes,8)!=8||memcmp(bytes,"!<arch>\n",8))return 11;
  int fd=open(archive,O_WRONLY|O_TRUNC|O_NONBLOCK);
  if(fd<0)return 12;
  if(write(fd,"B",1)!=1)return 13;
  if(close(fd))return 14;
  char byte;
  if(rd(archive,&byte,1)!=1||byte!='B')return 15;
  return tty_enxio?0:16;
 }
 if(!strcmp(mode,"null")){
  int fd=open("/dev/null",O_WRONLY|O_NONBLOCK);
  if(fd<0)return 20;
  if(write(fd,"x",1)!=1)return 21;
  return close(fd)?22:0;
 }
 if(!strcmp(mode,"failed-regular")){
  const char *existing=argv[2],*missing=argv[3];
  int a=open(existing,O_WRONLY|O_CREAT|O_EXCL|O_NONBLOCK,0600);
  if(a>=0){close(a);return 40;}
  if(errno!=EEXIST)return 41;
  int b=open(missing,O_WRONLY|O_NONBLOCK);
  if(b>=0){close(b);return 42;}
  return errno==ENOENT?0:43;
 }
 if(!strcmp(mode,"source-symlink")){
  const char *archive=argv[2];
  char bytes[8];
  if(rd(archive,bytes,8)!=8)return 50;
  int fd=open(archive,O_WRONLY|O_TRUNC|O_NONBLOCK);
  if(fd<0)return 51;
  if(write(fd,"B",1)!=1)return 52;
  return close(fd)?53:0;
 }
 if(!strcmp(mode,"dev-regular-write")){
  const char *path=argv[2];
  if(wr(path,"AAAAAAAA",8))return 60;
  int fd=open(path,O_WRONLY|O_TRUNC|O_NONBLOCK);
  if(fd<0)return 61;
  if(write(fd,"B",1)!=1)return 62;
  return close(fd)?63:0;
 }
 return 91;
}
'''

DISABLE = ('generated_vma_output', 'generated_vma_shared_mm',
           'generated_vma_private_wake', 'generated_vma_private_wait_mismatch',
           'generated_vma_coordinated_wait', 'generated_vma_parked_wait',
           'retained_generated_metadata')


class MetadataOpen(e2e.EndToEnd):
    def _owned_phase(self, label, args, *, source=None, expect_error=False):
        out = self.root / label
        out.mkdir(exist_ok=True)
        originals = out / 'originals'
        originals.mkdir(exist_ok=True)
        build = out / 'build'
        build.mkdir(exist_ok=True)
        source_dir = out / 'source'
        source_dir.mkdir(exist_ok=True)
        trusted = str(build.resolve())
        self.trusted_roots[label] = trusted
        observer = e2e.make_observer(originals, trusted)
        for key in DISABLE:
            setattr(observer, key, False)
        observer.generated_vma = None
        observer.source = str(source or source_dir)
        observer.owned_input_generations = e2e.obs.owned_input_module.Runtime(
            observer, e2e.obs.SimpleNamespace(
                probe=e2e.obs.probe, bindings=e2e.obs.bindings,
                memory_policy=e2e.obs.memory_policy, profile=e2e.obs.profile,
                path_argument=e2e.obs.path_argument,
                descriptor_flags=e2e.obs.descriptor_flags))
        binary = e2e.build(C, self.root / 'bin', 'metadata-' + label)
        phase = None
        error = None
        try:
            phase = observer.phase(
                'configure', [binary, *args], time.monotonic() + 30,
                cwd=str(e2e.ROOT),
                env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        except BaseException as exc:
            error = exc
            if not expect_error:
                traceback.print_exc()
        finally:
            observer.close()
            e2e._reap_all()
        result = dict(phase=phase, error=error, rows=[], report=None,
                      originals=originals, shards=[], out=out,
                      build=build, source=source_dir, binary=binary)
        if phase is not None:
            self.wire_refs[label] = {str(Path(ref['path'])): ref
                                     for ref in phase['rawTraceShards']}
            result['shards'] = [Path(ref['path']) for ref in phase['rawTraceShards']]
            result['report'] = self._replay(result['shards'], originals, label=label)
            _decoder, pairs = self._decode_rows(result['shards'], label)
            result['rows'] = [row for _path, row in pairs]
        return result

    def _stderr(self, result):
        receipt = result['phase']['commandReceipt']['stderr']
        return (result['originals'] / Path(receipt['path']).name).read_text()

    def _exits(self, result):
        return [row for row in result['rows']
                if row['kind'] == 'kernel-syscall' and row['op'] == 'exit']

    def _entries(self, result):
        return {row['sequence']: row for row in result['rows']
                if row['kind'] == 'kernel-syscall' and row['op'] == 'entry'}

    def _assert_negative_open(self, result, error_code):
        entries = self._entries(result)
        found = [row for row in self._exits(result)
                 if row['isError'] and row['result'] == -error_code]
        opens = [row for row in found
                 if entries[row['entrySequence']]['nr'] in (56, 257)]
        self.assertTrue(opens, 'no actual openat exit with errno %d' % error_code)
        return opens

    def test_headless_tty_enxio_and_regular_generation_same_phase(self):
        archive = self.root / 'tty-regular' / 'build' / 'libtest.a'
        result = self._owned_phase('tty-regular', ['tty-regular', str(archive)])
        self.assertIsNone(result['error'])
        self.assertEqual(result['phase']['commandReceipt']['exit'], 0)
        self.assertIn('TTY_ENXIO=1', self._stderr(result))
        self._assert_negative_open(result, errno.ENXIO)
        kinds = [row['kind'] for row in result['rows']]
        for required in ('owned-input-generation-retired',
                         'owned-input-generation-opened',
                         'owned-input-generation-acquired'):
            self.assertIn(required, kinds)
        retired = [row for row in result['rows']
                   if row['kind'] == 'owned-input-generation-retired']
        self.assertTrue(retired)
        self.assertEqual({row['path'] for row in retired}, {str(archive)})
        self.assertNotIn('/dev/tty', {row['path'] for row in retired})
        self.assertEqual(archive.read_bytes(), b'B')
        self.assertIsNotNone(result['report'])
        print('SDK90_R2_TTY_REGULAR_OK tty_enxio=1 generation_retired=%d' % len(retired), flush=True)

    def test_special_device_accessible_is_not_generation(self):
        result = self._owned_phase('null-device', ['null'])
        self.assertIsNone(result['error'])
        self.assertEqual(result['phase']['commandReceipt']['exit'], 0)
        self.assertFalse(any(row['kind'].startswith('owned-input-generation-retired')
                             for row in result['rows']))
        self.assertFalse(any(row.get('actualPath') == '/dev/null'
                             for row in result['rows']))
        self.assertIsNotNone(result['report'])
        print('SDK90_R2_NULL_DEVICE_OK', flush=True)

    def test_failed_regular_and_missing_opens_are_actual_negative(self):
        out = self.root / 'failed-open'
        (out / 'build').mkdir(parents=True)
        existing = out / 'build' / 'existing.a'
        missing = out / 'build' / 'missing.a'
        existing.write_bytes(b'AAAA')
        result = self._owned_phase('failed-open', ['failed-regular', str(existing), str(missing)])
        self.assertIsNone(result['error'])
        self.assertEqual(result['phase']['commandReceipt']['exit'], 0)
        self._assert_negative_open(result, errno.EEXIST)
        self._assert_negative_open(result, errno.ENOENT)
        self.assertFalse(any(row['kind'].startswith('owned-input-generation-retired')
                             for row in result['rows']))
        self.assertIsNotNone(result['report'])
        print('SDK90_R2_FAILED_OPENS_OK eexist=1 enoent=1', flush=True)

    def test_source_symlink_alias_is_refused_after_real_read_lease(self):
        out = self.root / 'source-alias'
        source = out / 'source'
        source.mkdir(parents=True)
        (out / 'build').mkdir()
        links = out / 'links'
        links.mkdir()
        original = source / 'original-input.a'
        original.write_bytes(b'AAAAAAAA')
        archive = links / 'libtest.a'
        os.symlink(original, archive)
        result = self._owned_phase('source-alias', ['source-symlink', str(archive)], expect_error=True)
        self.assertIsNotNone(result['error'])
        self.assertIn('source/dependency inode', str(result['error']))
        self.assertEqual(original.read_bytes(), b'AAAAAAAA')
        print('SDK90_R2_SOURCE_ALIAS_REFUSED', flush=True)

    def test_dev_regular_file_is_not_skipped_by_device_prefix(self):
        path = '/dev/sdk90-metadata-%d.a' % os.getpid()
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        try:
            result = self._owned_phase('dev-regular', ['dev-regular-write', path])
            self.assertIsNone(result['error'])
            self.assertEqual(result['phase']['commandReceipt']['exit'], 0)
            with open(path, 'rb') as source:
                self.assertEqual(source.read(), b'B')
            self.assertFalse(any(row['kind'].startswith('owned-input-generation-retired')
                                 for row in result['rows']))
            self.assertIsNotNone(result['report'])
            print('SDK90_R2_DEV_REGULAR_WRITE_OK', flush=True)
        finally:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass

    def test_metadata_only_flag_is_explicit_bool(self):
        for value in (1, 'yes', None):
            with self.subTest(value=value):
                with self.assertRaises(AssertionError):
                    e2e.obs.Observer.lifetime_open(object(), 1, '/dev/tty', metadata_only=value)
        print('SDK90_R2_METADATA_ONLY_BOOL_OK', flush=True)


def load_tests(loader, standard, pattern):
    return unittest.TestSuite(MetadataOpen(name) for name in MetadataOpen.__dict__
                              if name.startswith('test_'))


if __name__ == '__main__':
    suite = load_tests(unittest.defaultTestLoader, None, None)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun != 6 or result.skipped or not result.wasSuccessful():
        print('SDK90 metadata-open strict guard failed: testsRun=%d expected=6 skipped=%r successful=%r'
              % (result.testsRun, result.skipped, result.wasSuccessful()), file=sys.stderr, flush=True)
        raise SystemExit(1)
