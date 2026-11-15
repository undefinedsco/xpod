"""Fixed-layout loader + provenance verification for the observer's own TCB.

ROOT-fix 2: there is NO caller-supplied directory. The layout is a constant of
this module's own location. Specifying a directory re-introduces exactly the
"arbitrary user path + suffix then dlopen" hole the task forbids.

ROOT-fix 3: the loader does not merely check "the .so exists and sweep(()) has
the right shape". It CONSUMES the build receipt produced by the real compiler
child and verifies, before the module may be used:

  * the build receipt is at the fixed path next to the helper;
  * its recorded source sha256 equals the on-disk source bytes actually present
    in the component read-only context;
  * its recorded output sha256 AND byte length equal the on-disk ELF;
  * the ELF is the architecture/ABI this interpreter can load (EXT_SUFFIX);
  * the recorded interpreter version and include dir equal this interpreter.

Only then is the extension imported. Any mismatch is a hard failure: the caller
gets NativeBroken and MUST fail closed. No digest is ever read from a caller
dictionary, and nothing here grants trust on a caller-supplied hash.

Test seam: `_layout(module_dir)` is private and prefixed with `_`; it exists so
tests can point at a copied fixture tree. Production code never passes it.
"""
import hashlib
import importlib.util
import json
import os
import sysconfig

MODULE_NAME = 'lease_sweep_ext'
RECEIPT_NAME = 'build.receipt.json'


class NativeUnavailable(RuntimeError):
    """The native helper is absent. In SDK mode this MUST be fatal."""


class NativeBroken(NativeUnavailable):
    """The native helper exists but its provenance/ABI does not verify."""


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def _layout(module_dir):
    """(native dir, binding path, extension path, receipt path) for a module dir.

    Private seam for tests. Production always uses _default_layout().
    """
    native = os.path.join(module_dir, 'native')
    suffix = sysconfig.get_config_var('EXT_SUFFIX')
    if not suffix:
        raise NativeBroken('interpreter has no EXT_SUFFIX')
    return {
        'dir': native,
        'binding': os.path.join(native, 'lease_sweep_binding.py'),
        'extension': os.path.join(native, MODULE_NAME + suffix),
        'receipt': os.path.join(native, RECEIPT_NAME),
        'source': os.path.join(native, 'lease_sweep_ext.c'),
        'suffix': suffix,
    }


def _default_layout():
    """The ONE production layout: derived from this file's own location."""
    here = os.path.dirname(os.path.abspath(__file__))
    # This module lives at <scripts>/native/lease_sweep_binding.py
    return _layout(os.path.dirname(here))


def verify_provenance(layout=None):
    """Verify source/header/ELF/interpreter binding. Returns the parsed receipt.

    Raises NativeBroken on any inconsistency. Does NOT import the extension.
    """
    layout = layout or _default_layout()
    for key in ('extension', 'receipt', 'source'):
        if not os.path.isfile(layout[key]):
            raise NativeUnavailable('missing native helper component: ' + layout[key])
    try:
        with open(layout['receipt'], 'r') as handle:
            receipt = json.load(handle)
    except (OSError, ValueError) as error:
        raise NativeBroken('build receipt unreadable: %s' % error)

    if receipt.get('schemaVersion') != 1 or receipt.get('kind') != 'sdk-native-lease-helper-build-originals':
        raise NativeBroken('build receipt schema/kind differs')

    source = receipt.get('source') or {}
    if source.get('sha256') != _sha256(layout['source']):
        raise NativeBroken('recorded source hash differs from the actual component source')
    if source.get('bytes') != os.path.getsize(layout['source']):
        raise NativeBroken('recorded source length differs')

    output = receipt.get('output') or {}
    if output.get('sha256') != _sha256(layout['extension']):
        raise NativeBroken('recorded ELF hash differs from the actual built extension')
    if output.get('bytes') != os.path.getsize(layout['extension']):
        raise NativeBroken('recorded ELF length differs')

    interpreter = receipt.get('interpreter') or {}
    if interpreter.get('extSuffix') != layout['suffix']:
        raise NativeBroken('recorded EXT_SUFFIX differs from this interpreter ABI')
    expected_version = '%d.%d' % (__import__('sys').version_info[0], __import__('sys').version_info[1])
    if not str(interpreter.get('version', '')).startswith(expected_version):
        raise NativeBroken('recorded interpreter version differs from the running one')
    include = sysconfig.get_paths()['include']
    if interpreter.get('include') and interpreter['include'] != include:
        raise NativeBroken('recorded include dir differs from this interpreter')

    build = receipt.get('build') or {}
    if build.get('exit') != 0:
        raise NativeBroken('recorded compiler child did not exit 0')

    # Header originals: the receipt points at retained header originals with
    # their own hashes; we verify each one that is present on disk.
    headers = receipt.get('headerOriginals') or []
    if not headers:
        raise NativeBroken('no retained header originals in the build receipt')
    for row in headers:
        # Resolve against the CURRENT helper tree, never a build-time absolute
        # path: the same bytes must verify in an image layer or a copied fixture.
        relative = row.get('relativePath')
        if not relative or os.path.isabs(relative) or '..' in relative.split('/'):
            raise NativeBroken('header original must be a relative retained path')
        path = os.path.join(layout['dir'], relative)
        if not os.path.isfile(path):
            raise NativeBroken('retained header original missing: ' + path)
        if row.get('sha256') != _sha256(path):
            raise NativeBroken('retained header original hash differs: ' + path)
        if row.get('bytes') != os.path.getsize(path):
            raise NativeBroken('retained header original length differs: ' + path)
    return receipt


def load_required():
    """Load the TCB extension after provenance verification, or fail closed.

    There is intentionally no `directory` argument. The SDK observer calls this;
    a missing or broken helper must abort the observation rather than quietly
    checking fewer leases.
    """
    layout = _default_layout()
    verify_provenance(layout)
    spec = importlib.util.spec_from_file_location(MODULE_NAME, layout['extension'])
    if spec is None or spec.loader is None:
        raise NativeBroken('built extension unreadable')
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except ImportError as error:
        raise NativeBroken('built extension cannot be imported by this interpreter: %s' % error)
    for attribute in ('sweep', 'OK', 'LEASE', 'IDENTITY', 'ERRNO',
                      'plan_new', 'sweep_plan'):
        if not hasattr(module, attribute):
            raise NativeBroken('built extension incomplete: ' + attribute)
    if module.sweep(()) != (module.OK, -1, 0):
        raise NativeBroken('built extension answers the empty sweep incorrectly')
    # The current source REQUIRES the immutable-input plan API. A verified
    # receipt whose ELF lacks it must fail closed here, never silently fall back
    # to the generic sweep (that would quietly run a different helper than the
    # one this SDK was reviewed against).
    #
    # Same interruption contract as the generic smoke call above: the calls are
    # NOT wrapped, so a caller-owned SIGALRM/TimeoutError or an allocation
    # MemoryError propagates unchanged. Only an explicit, well-formed empty verdict
    # is required; a wrong one is NativeBroken.
    empty_plan = module.plan_new(())
    if module.sweep_plan(empty_plan) != (module.OK, -1, 0):
        raise NativeBroken('built extension answers the empty plan incorrectly')
    return module


def _translate(native, verdict, errno_value, reject):
    """The ONE verdict translator shared by every sweep entry point.

    No copy-paste mapping: sweep_rows and sweep_plan differ only in which native
    call produced the verdict tuple.
    """
    if verdict == native.OK:
        return
    if verdict == native.LEASE:
        reject('read lease no longer held')
    if verdict == native.IDENTITY:
        reject('leased inode identity changed')
    if verdict == native.ERRNO:
        if errno_value is None:
            raise OSError('lease check interrupted without errno')
        reject('lease check failed: ' + str(errno_value))
    raise NativeBroken('unknown native verdict: ' + str(verdict))


def sweep_plan(native, plan, reject):
    """Plan-scoped sweep. The capsule is an explicit OWNED argument.

    Every verdict still comes from the live per-row fcntl/fstat inside
    sweep_plan; only the decode of immutable registration inputs is reused.
    """
    if native is None:
        raise NativeBroken('native sweep requires a verified extension')
    verdict, _index, errno_value = native.sweep_plan(plan)
    _translate(native, verdict, errno_value, reject)


def sweep_rows(native, rows, reject):
    """Translate one native sweep verdict using the LeaseSet's own _reject.

    Keeps the oracle's exact message strings and first-error/sticky behaviour.
    """
    if native is None:
        raise NativeBroken('native sweep requires a verified extension')
    verdict, _index, errno_value = native.sweep(rows)
    _translate(native, verdict, errno_value, reject)
