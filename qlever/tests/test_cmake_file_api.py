"""File API adapter tests, including every root-review refusal.

Fixtures follow the DOCUMENTED cmake-file-api(7) schema (field names/semantics
from the manual). This tests OUR logic; tests/test_real_cmake.py tests whether
real CMake honours the query.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('api', HERE.parent / 'scripts/cmake_file_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
RESULTS = []


def case(name):
    def register(fn):
        RESULTS.append((name, fn))
        return fn
    return register


def tree(root, *, inputs=None, omit=(), generator='Ninja', dup_object=False,
         escape_ref=False, symlink_ref=False, bad_kind=False, empty_inputs=False,
         generated_input=False, nested_closure=False):
    build = os.path.join(root, 'build')
    source = os.path.join(root, 'source')
    os.makedirs(build); os.makedirs(source)
    inputs = inputs if inputs is not None else ['CMakeLists.txt']
    for name in inputs:
        path = os.path.join(source, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, 'w').write('# real input\n')
    if generated_input:
        # Official rule: a RELATIVE path is ALWAYS source-root relative, even for
        # an isGenerated entry. The file therefore lives under the source tree.
        os.makedirs(os.path.join(source, 'CMakeFiles'), exist_ok=True)
        open(os.path.join(source, 'CMakeFiles', 'CMakeSystem.cmake'), 'w').write('# gen\n')
    reply = os.path.join(build, '.cmake', 'api', 'v1', 'reply')
    os.makedirs(reply)
    rows = [] if empty_inputs else [{'path': n} for n in inputs]
    if generated_input:
        rows.append({'isGenerated': True, 'path': 'CMakeFiles/CMakeSystem.cmake'})
    cmake_files = {'kind': 'cmakeFiles', 'version': {'major': 1, 'minor': 1},
                   'paths': {'build': build, 'source': source}, 'inputs': rows}
    codemodel = {'kind': 'codemodel', 'version': {'major': 2, 'minor': 8},
                 'paths': {'build': build, 'source': source}, 'configurations': []}
    if nested_closure:
        # Real CMake references per-directory and per-target JSON from the
        # codemodel root, and those can reference further files.
        target = {'kind': 'target', 'name': 'a',
                  'artifacts': [{'path': 'a'}],
                  'children': {'jsonFile': 'target-a-child.json'}}
        directory = {'kind': 'directory', 'paths': {'build': '.'}}
        open(os.path.join(reply, 'target-a.json'), 'w').write(json.dumps(target))
        open(os.path.join(reply, 'target-a-child.json'), 'w').write(
            json.dumps({'kind': 'child', 'note': 'nested target child'}))
        open(os.path.join(reply, 'dir-0.json'), 'w').write(json.dumps(directory))
        codemodel['configurations'] = [{
            'name': 'Release',
            'directories': [{'source': '.', 'build': '.', 'jsonFile': 'dir-0.json'}],
            'targets': [{'name': 'a', 'id': 'a::@', 'jsonFile': 'target-a.json'}],
        }]
    objects = []
    for kind, value, filename in (('cmakeFiles', cmake_files, 'cmakeFiles-v1.json'),
                                  ('codemodel', codemodel, 'codemodel-v2.json')):
        if kind in omit:
            continue
        if symlink_ref and kind == 'cmakeFiles':
            # symlinked reply original: real file elsewhere, referenced by link
            real = os.path.join(reply, 'real-' + filename)
            open(real, 'w').write(json.dumps(value))
            os.symlink(real, os.path.join(reply, filename))
            objects.append({'kind': kind,
                            'version': {'major': 1, 'minor': 0},
                            'jsonFile': filename})
            continue
        open(os.path.join(reply, filename), 'w').write(
            json.dumps({'kind': 'other'} if bad_kind else value))
        ref = filename
        if escape_ref:
            ref = '../../../../etc/passwd'
        objects.append({'kind': kind,
                        'version': {'major': 1 if kind == 'cmakeFiles' else 2, 'minor': 0},
                        'jsonFile': ref})
        if dup_object:
            objects.append(dict(objects[-1]))
    index = {'cmake': {'version': {'major': 3, 'minor': 28, 'patch': 0},
                       'paths': {'cmake': '/usr/bin/cmake'},
                       'generator': {'multiConfig': False, 'name': generator}},
             'objects': objects, 'reply': {}}
    open(os.path.join(reply, 'index-2026-01-01T00-00-00-0000.json'), 'w').write(json.dumps(index))
    return build


def with_tree(**kw):
    def wrap(fn):
        def run():
            root = tempfile.mkdtemp(prefix='fa-')
            try:
                return fn(tree(root, **kw), root)
            finally:
                shutil.rmtree(root, ignore_errors=True)
        return run
    return wrap


def refused(fn, fragment):
    try:
        fn()
    except api.FileApiUnavailable as error:
        assert fragment in str(error), 'refused for the WRONG reason: %s' % error
        return str(error)[:66]
    raise AssertionError('was accepted but must be refused')


@case('POSITIVE: cmakeFiles inputs resolve, all originals returned')
@with_tree()
def _(build, root):
    paths, originals = api.configure_inputs(build)
    assert any(p.endswith('CMakeLists.txt') for p in paths), paths
    assert len(originals) == 3, len(originals)          # index + 2 replies
    return '%d paths, %d originals' % (len(paths), len(originals))


@case('isGenerated is informational: relative still resolves to SOURCE')
@with_tree(generated_input=True)
def _(build, root):
    paths, _ = api.configure_inputs(build)
    generated = [p for p in paths if p.endswith('CMakeSystem.cmake')]
    assert len(generated) == 1, paths
    assert os.path.realpath(generated[0]).startswith(
        os.path.realpath(os.path.join(root, 'source'))), generated
    return 'isGenerated relative -> source root'


@case('ambiguous sibling: relative input exists in BOTH trees -> source wins')
@with_tree()
def _(build, root):
    # A decoy with the SAME relative name under the build tree must be ignored.
    os.makedirs(os.path.join(build, 'decoy'), exist_ok=True)
    open(os.path.join(build, 'CMakeLists.txt'), 'w').write('# build decoy\n')
    paths, _ = api.configure_inputs(build)
    resolved = [p for p in paths if p.endswith('CMakeLists.txt')]
    assert len(resolved) == 1, paths
    assert os.path.realpath(resolved[0]).startswith(
        os.path.realpath(os.path.join(root, 'source'))), resolved
    return 'source chosen, build sibling ignored'


@case('relative input missing under source is REFUSED (no build fallback)')
@with_tree()
def _(build, root):
    os.unlink(os.path.join(root, 'source', 'CMakeLists.txt'))
    # and a build-tree twin exists to tempt a fallback
    open(os.path.join(build, 'CMakeLists.txt'), 'w').write('# build only\n')
    return refused(lambda: api.configure_inputs(build),
                   'no build-root fallback')


@case('read-only: configure_inputs creates no query files')
@with_tree()
def _(build, root):
    api.configure_inputs(build)
    assert not os.path.isdir(api.query_dir(build)), 'reads must not create queries'
    return 'no query dir created by reading'


@case('duplicate object kind/version refused (no first-pick)')
@with_tree(dup_object=True)
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'exactly one is required')


@case('jsonFile escaping the reply dir refused')
@with_tree(escape_ref=True)
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'escapes the reply directory')


@case('symlinked reply original refused')
@with_tree(symlink_ref=True)
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'must not be a symlink')


@case('reply kind mismatch refused')
@with_tree(bad_kind=True)
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'kind mismatch')


@case('missing cmakeFiles object refused')
@with_tree(omit=('cmakeFiles',))
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'did not return cmakeFiles-v1')


@case('empty inputs refused (no empty fallback)')
@with_tree(empty_inputs=True)
def _(build, root):
    return refused(lambda: api.configure_inputs(build), 'listed no configure inputs')


@case('missing input file refused')
@with_tree()
def _(build, root):
    os.unlink(os.path.join(root, 'source', 'CMakeLists.txt'))
    return refused(lambda: api.configure_inputs(build),
                   'missing under the source root')


@case('no reply dir refused')
def _():
    root = tempfile.mkdtemp(prefix='fa-')
    try:
        build = os.path.join(root, 'build'); os.makedirs(build)
        return refused(lambda: api.configure_inputs(build), 'reply directory absent')
    finally:
        shutil.rmtree(root, ignore_errors=True)


@case('verify_queries_present fails when query absent')
@with_tree()
def _(build, root):
    return refused(lambda: api.verify_queries_present(build), 'query original missing')


@case('verify_queries_present passes for the written empty form')
@with_tree()
def _(build, root):
    api.write_queries(build)
    assert api.verify_queries_present(build) is True
    return 'empty stateless queries verified'


@case('codemodel closure retains nested target children and directories')
@with_tree(nested_closure=True)
def _(build, root):
    api.write_queries(build)                 # queries precede configure
    paths, originals = api.codemodel_closure(build)
    names = {os.path.basename(p) for p in paths}
    assert 'codemodel-v2.json' in names, names
    assert 'target-a.json' in names, names
    assert 'dir-0.json' in names, names
    assert 'target-a-child.json' in names, names     # the nested child
    return '%d closure members incl. nested child' % len(paths)


@case('codemodel closure refuses a reference escaping the reply dir')
@with_tree(nested_closure=True)
def _(build, root):
    path = os.path.join(api.reply_dir(build), 'target-a-child.json')
    open(path, 'w').write(json.dumps({'kind': 'child', 'jsonFile': '../../../../etc/passwd'}))
    api.write_queries(build)
    return refused(lambda: api.codemodel_closure(build), 'escapes the reply directory')


@case('generator read back, never assumed')
@with_tree(generator='Unix Makefiles')
def _(build, root):
    assert api.generator(build) == 'Unix Makefiles'
    return 'Unix Makefiles'


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
    print('%d/%d File API cases pass' % (len(RESULTS) - len(failures), len(RESULTS)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
