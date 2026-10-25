"""Backend boundary + fail-closed gate -- CI-runnable, repo-relative.

Covers, against the REAL compiled helper and the REAL patched factory module:

  * base LeaseSet is pure and works with the native directory absent;
  * SdkLeaseSet is required and RAISES when the helper is missing;
  * SdkLeaseSet raises on source / header / ELF / ABI corruption;
  * the backend is resolved once, not per check;
  * a deliberately wrong product formatter makes the gate FAIL (negative case).
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import native_lease_gate as gate  # noqa: E402

_GATE = None
PATCHED_FACTORY = os.path.join(os.path.dirname(os.path.dirname(HERE)),
                               'qlever', 'scripts', 'sdk-tool-lifetime-leases.py')


def setUpModule():
    global _GATE
    _GATE = gate.LeaseGate().build()
    # The gate's fixture must carry the REAL patched module at the fixed path.
    factory = os.environ.get('NATIVE_LEASE_FACTORY') or PATCHED_FACTORY
    if not os.path.isfile(factory):
        raise gate.GateUnavailable('patched factory module not present: ' + factory)
    _GATE.install_factory(factory)


def tearDownModule():
    if _GATE is not None:
        _GATE.close()


def g():
    return _GATE


def fresh_tree():
    """Copy the built fixture so corruption cases cannot affect each other."""
    root = tempfile.mkdtemp(prefix='backend-case-', dir=g().root)
    scripts = os.path.join(root, 'qlever', 'scripts')
    shutil.copytree(os.path.join(g().scripts), scripts)
    return root, scripts


def load_module(path, name='m'):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BaseStaysPure(unittest.TestCase):
    def test_base_class_attribute_is_false(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'base_a')
        self.assertIs(module.LeaseSet._native_backend_required, False)

    def test_base_works_with_native_directory_deleted(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        shutil.rmtree(os.path.join(scripts, 'native'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'base_b')
        group = module.LeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        self.assertIsNone(group._native)
        p = os.path.join(root, 'lease')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        group.check()
        self.assertIsNone(group._failure)

    @staticmethod
    def _quiet(group):
        try: group.close()
        except Exception: pass


class SdkIsRequired(unittest.TestCase):
    def test_sdk_class_attribute_is_true(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_a')
        self.assertIs(module.SdkLeaseSet._native_backend_required, True)
        self.assertTrue(issubclass(module.SdkLeaseSet, module.LeaseSet))

    def test_sdk_raises_when_native_directory_missing(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        shutil.rmtree(os.path.join(scripts, 'native'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_b')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_when_binding_missing(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        os.unlink(os.path.join(scripts, 'native', 'lease_sweep_binding.py'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_c')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_elf(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_d')
        ext = module._load_native_lease_sweep()
        # corrupt the ELF bytes the receipt pinned
        import sysconfig
        so = os.path.join(scripts, 'native',
                          'lease_sweep_ext' + sysconfig.get_config_var('EXT_SUFFIX'))
        with open(so, 'r+b') as h:
            h.seek(80); h.write(b'\xde\xad\xbe\xef')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_source(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        with open(os.path.join(scripts, 'native', 'lease_sweep_ext.c'), 'a') as h:
            h.write('\n/* tampered */\n')
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_e')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_corrupted_header_original(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        receipt = json.load(open(os.path.join(scripts, 'native', 'build.receipt.json')))
        first = receipt['headerOriginals'][0]['relativePath']
        with open(os.path.join(scripts, 'native', first), 'a') as h:
            h.write('\n/* tampered */\n')
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_f')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_raises_on_abi_suffix_mismatch(self):
        root, scripts = fresh_tree()
        self.addCleanup(shutil.rmtree, root, True)
        path = os.path.join(scripts, 'native', 'build.receipt.json')
        receipt = json.load(open(path))
        receipt['interpreter']['extSuffix'] = '.cpython-999-x86_64-linux-gnu.so'
        json.dump(receipt, open(path, 'w'))
        module = load_module(os.path.join(scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_g')
        with self.assertRaises(Exception):
            module.SdkLeaseSet()

    def test_sdk_loads_and_checks_with_real_backend(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_h')
        group = module.SdkLeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        self.assertIsNotNone(group._native)
        p = os.path.join(g().root, 'lease-real')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        group.check()
        self.assertIsNone(group._failure)

    def test_backend_resolved_once_not_per_check(self):
        module = load_module(os.path.join(g().scripts, 'sdk-tool-lifetime-leases.py'), 'sdk_i')
        group = module.SdkLeaseSet()
        self.addCleanup(lambda: self._quiet(group))
        p = os.path.join(g().root, 'lease-once')
        with open(p, 'wb') as h: h.write(b'x' * 64)
        fd = os.open(p, os.O_RDONLY)
        self.addCleanup(lambda: os.close(fd))
        group.acquire(fd)
        calls = {'n': 0}
        original = group._native.sweep
        def counting(rows):
            calls['n'] += 1
            return original(rows)
        group._native.sweep = counting
        for _ in range(5):
            group.check()
        self.assertEqual(calls['n'], 5, 'one sweep per check, no re-verification')

    @staticmethod
    def _quiet(group):
        try: group.close()
        except Exception: pass


class NegativeGateCase(unittest.TestCase):
    """A deliberately broken product formatter MUST make this gate fail.

    This is the meta-check the reviewer asked for: it proves the gate is not
    vacuous. We compile a copy of the source with the format string broken and
    assert the width contract catches it.
    """

    def test_wrong_formatter_is_caught_by_the_gate(self):
        import re
        source = open(os.path.join(g().native, 'lease_sweep_ext.c')).read()
        broken = source.replace('Py_BuildValue("(ini)"', 'Py_BuildValue("(nin)"')
        self.assertNotEqual(broken, source, 'the source must contain the formatter to break it')
        # Compile the broken copy in its own gate fixture.
        with gate.LeaseGate() as other:
            broken_path = os.path.join(other.root, 'broken.c')
            with open(broken_path, 'w') as handle:
                handle.write(broken)
            other.build(source=broken_path)
            ext = other.load_extension()
            # Under "(nin)" the index is truncated; 2**31 must NOT survive.
            ok, index, errno_value = ext.index_roundtrip(2 ** 31)
            self.assertNotEqual((ok, index, errno_value), (0, 2 ** 31, 0),
                                'a wrong formatter must NOT produce a correct tuple')


if __name__ == '__main__':
    unittest.main(verbosity=2)
