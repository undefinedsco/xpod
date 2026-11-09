"""Link adapter tests: real capture leaf, shared origin record, refusals.

The adapter now runs the generator through the EXISTING SDK command leaf
(`commands.capture`), so these tests stage the real sibling modules and use a
stand-in `ninja` that prints what `-t commands -s <target>` prints. The adapter
validates the LINK SHAPE from the retained raw stdout, so the tool name is
irrelevant.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import stat
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / 'scripts'
RESULTS = []
TARGET = 'qlever-server'


def case(name):
    def register(fn):
        RESULTS.append((name, fn))
        return fn
    return register


class Budget:
    def __init__(self, seconds=600.0):
        self.seconds = seconds
    def remaining(self):
        return self.seconds
    def check(self, reserve=0):
        if self.seconds <= reserve:
            raise TimeoutError('budget exhausted')
    def timeout(self, cap, reserve=0):
        self.check(reserve)
        return min(cap, self.seconds - reserve)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LINK = load('link_under_test', 'link_command_adapter.py')


def tool(root, stdout, code=0):
    path = os.path.join(root, 'ninja')
    with open(path, 'w') as handle:
        handle.write('#!/bin/sh\ncat <<\'OUT\'\n' + stdout.rstrip('\n') + '\nOUT\nexit %d\n' % code)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


GOOD = ('/usr/bin/c++ -O2 CMakeFiles/qlever-server.dir/src/ServerMain.cpp.o '
        'lib/libengine.a lib/libserver.a -lpthread -o qlever-server\n')


def with_build(stdout, code=0):
    def wrap(fn):
        def run():
            root = tempfile.mkdtemp(prefix='lk-')
            try:
                build = os.path.join(root, 'build')
                materials = os.path.join(root, 'materials')
                os.makedirs(build); os.makedirs(materials)
                open(os.path.join(build, 'build.ninja'), 'w').write('# graph\n')
                return fn(root, build, materials, tool(root, stdout, code))
            finally:
                shutil.rmtree(root, ignore_errors=True)
        return run
    return wrap


def retain(build, materials, t, **kw):
    return LINK.retain(build, TARGET, generator='Ninja', tool=t,
                       materials=materials, cwd=build, budget=Budget(), **kw)


@case('POSITIVE: real capture retained, link.txt + origin written')
@with_build(GOOD)
def _(root, build, materials, t):
    r = retain(build, materials, t)
    assert r['origin'] == 'ninja-tool-introspection'
    assert r['objects'] and r['libraries']
    link = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt')
    assert os.path.isfile(link)
    record = json.load(open(os.path.join(os.path.dirname(link), 'origin.json')))
    for key in ('rawStdout', 'rawStderr', 'linkTxt', 'argv', 'linkLine'):
        assert key in record, key
    assert record['linkTxt']['sha256']
    return 'origin keys complete'


@case('capture went through the real SDK leaf (receipt + raw streams)')
@with_build(GOOD)
def _(root, build, materials, t):
    r = retain(build, materials, t)
    cap = r['capture']
    for key in ('receipt', 'stdout', 'stderr', 'supervisionReceipt'):
        assert key in cap, key
    receipt = json.load(open(os.path.join(materials, cap['receipt']['path'])))
    assert receipt['actualWait'] is True
    return 'actualWait receipt retained'


@case('REAL CI SHAPE: `: && cc ... && :` unwraps to the compiler argv')
@with_build(': && ' + GOOD.splitlines()[0] + ' && :\n')
def _(root, build, materials, t):
    r = retain(build, materials, t)
    assert r['unwrapped'] is True
    assert r['linkLine'].startswith('/usr/bin/c++ ')
    return 'raw preserved, argv derived'


@case('real shell work around the link is REFUSED')
@with_build('mkdir -p out && ' + GOOD)
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'single command' in str(e), e
        return str(e)[:56]
    raise AssertionError('dropped a real shell step')


@case('post-link step is REFUSED (would be lost)')
@with_build(GOOD.rstrip('\n') + ' && cp qlever-server x\n')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'single command' in str(e), e
        return str(e)[:56]
    raise AssertionError('dropped a post-link step')


@case('`true` no-op is stripped')
@with_build('true && ' + GOOD)
def _(root, build, materials, t):
    assert retain(build, materials, t)['linkLine'].startswith('/usr/bin/c++ ')
    return 'true stripped'


@case('two candidate link lines REFUSED (ambiguous)')
@with_build(GOOD + GOOD)
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'exactly one link line' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted ambiguous link lines')


@case('duplicate -o REFUSED')
@with_build('/usr/bin/c++ a.o -lpthread -o qlever-server -o qlever-server\n')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'exactly one -o' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted duplicate -o')


@case('no object files REFUSED')
@with_build('/usr/bin/c++ -lpthread -o qlever-server\n')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'no object files' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted no-object link')


@case('no library inputs REFUSED')
@with_build('/usr/bin/c++ a.o -o qlever-server\n')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'no library inputs' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted no-library link')


@case('repeated object REFUSED')
@with_build('/usr/bin/c++ a.o a.o -lpthread -o qlever-server\n')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'repeats an object' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted duplicated object')


@case('failing tool REFUSED through the capture leaf')
@with_build('', code=1)
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'unsupported' in str(e) or 'failed' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted a failing tool')


@case('empty output REFUSED')
@with_build('')
def _(root, build, materials, t):
    try:
        retain(build, materials, t)
    except LINK.LinkCommandUnavailable as e:
        assert 'no commands' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted empty output')


@case('POSITIVE Makefiles: CMake original preserved, tool NEVER run')
def _():
    root = tempfile.mkdtemp(prefix='lk-')
    try:
        build = os.path.join(root, 'build')
        d = os.path.join(build, 'CMakeFiles', TARGET + '.dir'); os.makedirs(d)
        open(os.path.join(d, 'link.txt'), 'w').write(GOOD)
        marker = os.path.join(root, 'ran')
        t = os.path.join(root, 'ninja')
        open(t, 'w').write('#!/bin/sh\ntouch %r\nexit 9\n' % marker)
        os.chmod(t, 0o755)
        r = LINK.retain(build, TARGET, generator='Unix Makefiles', tool=t)
        assert r['executedMake'] is False and r['origin'] == 'cmake-owned'
        assert not os.path.exists(marker), 'the tool was invoked for Makefiles!'
        return 'cmake-owned preserved, tool not run'
    finally:
        shutil.rmtree(root, ignore_errors=True)


@case('Makefiles: missing CMake link.txt REFUSED (no make fallback)')
def _():
    root = tempfile.mkdtemp(prefix='lk-')
    try:
        build = os.path.join(root, 'build'); os.makedirs(build)
        try:
            LINK.retain(build, TARGET, generator='Unix Makefiles', tool='/bin/true')
        except LINK.LinkCommandUnavailable as e:
            assert 'already contain the CMake-owned link.txt' in str(e), e
            return str(e)[:56]
        raise AssertionError('accepted a Makefiles tree with no link.txt')
    finally:
        shutil.rmtree(root, ignore_errors=True)


@case('Makefiles: a derived origin present REFUSED')
def _():
    root = tempfile.mkdtemp(prefix='lk-')
    try:
        build = os.path.join(root, 'build')
        d = os.path.join(build, 'CMakeFiles', TARGET + '.dir'); os.makedirs(d)
        open(os.path.join(d, 'link.txt'), 'w').write(GOOD)
        open(os.path.join(d, 'origin.json'), 'w').write('{}')
        try:
            LINK.retain(build, TARGET, generator='Unix Makefiles', tool='/bin/true')
        except LINK.LinkCommandUnavailable as e:
            assert 'must not carry a derived origin' in str(e), e
            return str(e)[:56]
        raise AssertionError('accepted an origin on a Makefiles build')
    finally:
        shutil.rmtree(root, ignore_errors=True)


@case('unsupported generator REFUSED')
def _():
    try:
        LINK.retain('/b', TARGET, generator='Visual Studio 17 2022', tool='/bin/true')
    except LINK.LinkCommandUnavailable as e:
        assert 'unsupported generator' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted an unsupported generator')


@case('missing capture arguments REFUSED (no invented timeout)')
@with_build(GOOD)
def _(root, build, materials, t):
    try:
        LINK.retain(build, TARGET, generator='Ninja', tool=t)
    except LINK.LinkCommandUnavailable as e:
        assert 'real capture leaf requires' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted missing materials/cwd/budget')


@case('budget without the real interface REFUSED')
@with_build(GOOD)
def _(root, build, materials, t):
    for bad in (None, object()):
        try:
            LINK.retain(build, TARGET, generator='Ninja', tool=t, materials=materials,
                        cwd=build, budget=bad)
        except LINK.LinkCommandUnavailable as e:
            assert 'ExecutionBudget is required' in str(e), e
            continue
        raise AssertionError('accepted a non-budget %r' % (bad,))
    return 'all non-budget objects refused'


@case('exhausted budget propagates TimeoutError unchanged')
@with_build(GOOD)
def _(root, build, materials, t):
    class Exhausted(Budget):
        def check(self, reserve=0):
            raise TimeoutError('SDK producer deadline reserve exhausted')
    try:
        LINK.retain(build, TARGET, generator='Ninja', tool=t, materials=materials,
                    cwd=build, budget=Exhausted())
    except TimeoutError:
        return 'deadline propagated'
    raise AssertionError('ran with an exhausted budget')


def main():
    failures = []
    for name, fn in RESULTS:
        try:
            print('%-58s PASS  %s' % (name, fn()))
        except AssertionError as error:
            failures.append(name); print('%-58s FAIL  %s' % (name, error))
        except BaseException as error:      # noqa: BLE001
            failures.append(name); print('%-58s ERROR %s: %s' % (name, type(error).__name__, error))
    print()
    print('%d/%d link cases pass' % (len(RESULTS) - len(failures), len(RESULTS)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
