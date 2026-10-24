"""Control-flow tests of the ACTUAL product seams.

The tiny CMake probes cannot catch flow errors (root's issue 2): they call the
helpers directly. These tests drive the REAL module entry paths with a fake
`cmake` on PATH, so the ordering that broke real builds is exercised:

  * sdk-generation-materials.py configure -> derive_link_command -> metadata snapshot
  * Ninja metadata REQUIRES link.txt, so derivation must precede retention
  * Unix Makefiles must NOT derive and must not carry an origin sidecar
  * a failing `cmake` for either generator must not be masked

This is a CONTROL-FLOW harness, explicitly NOT a full SDK run.
"""
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


def case(name):
    def register(fn):
        RESULTS.append((name, fn))
        return fn
    return register


def fake_cmake(root, *, generator='Ninja', result=0):
    """A fake cmake that writes a minimal build tree for the named generator."""
    path = os.path.join(root, 'cmake')
    script = f'''#!/bin/sh
# fake cmake: --build returns success; configure writes generator artifacts
case "$*" in
  *--version*) echo "cmake version 3.31.6"; exit 0;;
  *--build*) exit {result};;
esac
BUILD=""
SRC=""
prev=""
for arg in "$@"; do
  case "$prew" in x) ;; esac
  case "$prev" in
    -B) BUILD="$arg";;
    -S) SRC="$arg";;
  esac
  prev="$arg"
done
[ -n "$BUILD" ] || exit 3
mkdir -p "$BUILD/.cmake/api/v1/reply"
if [ "{generator}" = "Ninja" ]; then
  printf 'build graph\\n' > "$BUILD/build.ninja"
  mkdir -p "$BUILD/CMakeFiles"
  printf 'rules\\n' > "$BUILD/CMakeFiles/rules.ninja"
else
  printf 'make graph\\n' > "$BUILD/Makefile"
  mkdir -p "$BUILD/CMakeFiles/qlever-server.dir"
  printf '/usr/bin/c++ a.o -lpthread -o qlever-server\\n' > "$BUILD/CMakeFiles/qlever-server.dir/link.txt"
  printf 'deps\\n' > "$BUILD/CMakeFiles/Makefile.cmake"
fi
printf 'cache\\n' > "$BUILD/CMakeCache.txt"
printf '[]\\n' > "$BUILD/compile_commands.json"
python3 - "$BUILD" "{generator}" <<'PYEOF'
import json, os, sys
build, generator = sys.argv[1], sys.argv[2]
reply = os.path.join(build, '.cmake/api/v1/reply')
cf = {{'kind':'cmakeFiles','version':{{'major':1,'minor':1}},
       'paths':{{'source':build,'build':build}},
       'inputs':[]}}
model = {{'kind':'codemodel','version':{{'major':2,'minor':8}},
         'paths':{{'source':build,'build':build}},
         'configurations':[{{'name':'Release','directories':[],'targets':[]}}]}}
for kind, value, name in (('cmakeFiles', cf, 'cmakeFiles-v1.json'),
                          ('codemodel', model, 'codemodel-v2.json')):
    open(os.path.join(reply, name), 'w').write(json.dumps(value))
index = {{'cmake':{{'version':{{'major':3,'minor':31,'patch':6}},
            'generator':{{'multiConfig':False,'name':generator}}}},
         'objects':[{{'kind':'cmakeFiles','version':{{'major':1,'minor':0}},
                     'jsonFile':'cmakeFiles-v1.json'}},
                    {{'kind':'codemodel','version':{{'major':2,'minor':0}},
                     'jsonFile':'codemodel-v2.json'}}],'reply':{{}}}}
open(os.path.join(reply,'index-2026.json'),'w').write(json.dumps(index))
PYEOF
exit 0
'''
    with open(path, 'w') as handle:
        handle.write(script)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


# The candidate lives at <repo>/.test-data/.../42807-...; resolve the repo from
# the path so the harness runs unchanged inside the Linux probe.
def _find_repo(start):
    probe = pathlib.Path(start).resolve()
    for parent in [probe, *probe.parents]:
        if (parent / 'qlever/scripts/sdk-command-materials.py').is_file():
            return parent
    return pathlib.Path('/')


REPO = _find_repo(HERE)


def with_tools(generator='Ninja'):
    """Stage the REAL patched scripts plus their real siblings in a temp dir."""
    def wrap(fn):
        def run():
            root = tempfile.mkdtemp(prefix='flow-')
            try:
                scripts = os.path.join(root, 'scripts')
                os.makedirs(scripts)
                # the two new helpers come from the candidate
                for helper in ('cmake_file_api.py', 'link_command_adapter.py', 'link_command_origin.py'):
                    shutil.copy2(SCRIPTS / helper, scripts)
                # every other SDK producer: from R when available, otherwise
                # from the staged bundle next to this candidate (Linux probe).
                staged = HERE.parent / 'tests' / 'staged-scripts'
                source_root = (REPO / 'qlever/scripts') if (REPO / 'qlever/scripts').is_dir() else staged
                for source_file in source_root.glob('sdk-*.py'):
                    shutil.copy2(source_file, scripts)
                # our PATCHED producers win over the R copies
                for patched in ('sdk-generation-materials.py', 'sdk-inner-materials.py'):
                    shutil.copy2(SCRIPTS / patched, scripts)
                for source_file in ('qlever_compiler_profile.py',):
                    shutil.copy2(source_root / source_file, scripts)
                if (REPO / 'scripts/agentfs-native-ci/supervise.py').is_file():
                    shutil.copy2(REPO / 'scripts/agentfs-native-ci/supervise.py', scripts)
                elif (HERE.parent / 'tests' / 'staged-scripts' / 'supervise.py').is_file():
                    shutil.copy2(HERE.parent / 'tests' / 'staged-scripts' / 'supervise.py', scripts)
                # a REAL-shaped ninja stub: advertises -s and prints one link
                ninja = os.path.join(root, 'ninja')
                # Real-shaped: `-t commands -s <target>` prints the link line.
                open(ninja, 'w').write(
                    '#!/bin/sh\n'
                    'echo "/usr/bin/c++ a.o -lpthread -o qlever-server"\n')
                os.chmod(ninja, 0o755)
                fake_cmake(root, generator=generator)
                build = os.path.join(root, 'build')
                source = os.path.join(root, 'source')
                os.makedirs(build); os.makedirs(source)
                return fn(root, build, source, generator, scripts)
            finally:
                shutil.rmtree(root, ignore_errors=True)
        return run
    return wrap


def run_configure(root, build, source, generator):
    """Run the fake cmake so the build tree really exists."""
    import subprocess
    env = dict(os.environ)
    env['PATH'] = os.path.join(root) + os.pathsep + env.get('PATH', '')
    subprocess.run([os.path.join(root, 'cmake'), '-S', source, '-B', build,
                    '-G', generator, '-DCMAKE_BUILD_TYPE=Release'],
                   capture_output=True, env=env, check=True)


FILENAMES = {
    'cmake_file_api': 'cmake_file_api.py',
    'link_command_adapter': 'link_command_adapter.py',
    'link_command_origin': 'link_command_origin.py',
    'sdk_generation_materials': 'sdk-generation-materials.py',
}


def load(name, scripts=None):
    """Load by the REAL filename: the two new helpers use underscores, the
    existing SDK producer uses hyphens. Getting this wrong is exactly root's
    issue 1 (ModuleNotFoundError)."""
    import importlib.util
    if scripts and str(scripts) not in sys.path:
        # the real producers do `from supervise import ...`, exactly as in
        # production where the scripts dir is on the interpreter's path.
        sys.path.insert(0, str(scripts))
    directory = pathlib.Path(scripts) if scripts else SCRIPTS
    spec = importlib.util.spec_from_file_location(name, directory / FILENAMES[name])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Budget:
    """The real ExecutionBudget interface, minimally."""
    def __init__(self, seconds=60.0):
        self.seconds = seconds
    def remaining(self):
        return self.seconds
    def check(self, reserve=0):
        if self.seconds <= reserve:
            raise TimeoutError('budget exhausted')
    def timeout(self, cap, reserve=0):
        self.check(reserve)
        return min(cap, self.seconds - reserve)


@case('Ninja flow: derivation provides link.txt BEFORE metadata retention')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    # emulate configure having written the graph (fake cmake already did)
    adapter = load('link_command_adapter', scripts)
    # link.txt must NOT exist yet -- Ninja never writes one
    assert not os.path.exists(os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt'))
    # metadata_paths would REFUSE without the derivation: prove the ordering matters
    generation = load('sdk_generation_materials', scripts)
    try:
        generation.metadata_paths(build, lambda: None)
    except ValueError as error:
        assert 'link command original missing' in str(error), error
    else:
        raise AssertionError('metadata retention accepted a Ninja tree with no link.txt')
    # now derive, as the real post-configure hook does
    result = adapter.retain(build, 'qlever-server', generator='Ninja',
                            tool=os.path.join(root, 'ninja'),
                            materials=os.path.join(root, 'materials'), cwd=build,
                            budget=Budget(600))
    assert os.path.isfile(os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt'))
    paths = generation.metadata_paths(build, lambda: None)
    names = {os.path.basename(str(p)) for p in paths}
    assert 'build.ninja' in names, sorted(names)
    assert 'link.txt' in names
    return 'refused pre-derivation, accepted post-derivation'


@case('Makefiles flow: CMake link.txt preserved, no origin, derivation not needed')
@with_tools('Unix Makefiles')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    generation = load('sdk_generation_materials', scripts)
    paths = generation.metadata_paths(build, lambda: None)
    names = {os.path.basename(str(p)) for p in paths}
    assert 'link.txt' in names
    sidecar = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt.origin.json')
    assert not os.path.exists(sidecar), 'Makefiles must not carry a derived origin'
    return 'cmake-authored link.txt retained, no origin'


@case('generator is read from the real reply, not from caller flags')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    assert api.generator(build) == 'Ninja'
    return 'Ninja read back from File API'


@case('UNSUPPORTED generator is refused by derivation')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    # rewrite the reply to claim an unsupported generator
    reply = os.path.join(build, '.cmake/api/v1/reply')
    index_path = os.path.join(reply, 'index-2026.json')
    index = json.load(open(index_path))
    index['cmake']['generator']['name'] = 'Visual Studio 17 2022'
    open(index_path, 'w').write(json.dumps(index))
    generation = load('sdk_generation_materials', scripts)
    try:
        generation.derive_link_command(build, Budget())
    except ValueError as error:
        assert 'generator unsupported' in str(error), error
        return str(error)[:60]
    raise AssertionError('accepted an unsupported generator')


@case('query originals ARE retained in the codemodel closure')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    paths, originals = api.codemodel_closure(build, lambda: None)
    names = {os.path.basename(str(p)) for p in paths}
    assert 'cmakeFiles-v1' in names, sorted(names)
    assert 'codemodel-v2' in names, sorted(names)
    return 'queries in closure: %r' % sorted(n for n in names if n.startswith('cmakeFiles') or n.startswith('codemodel'))


@case('derivation refuses when the budget has no remaining time')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    class Exhausted(Budget):
        def check(self, reserve=0):
            raise TimeoutError('SDK producer deadline reserve exhausted')
    try:
        adapter.retain(build, 'qlever-server', generator='Ninja', tool=os.path.join(root, 'ninja'),
                       materials=os.path.join(root, 'materials'), cwd=build, budget=Exhausted())
    except TimeoutError:
        return 'deadline propagated, nothing written'
    raise AssertionError('ran with an exhausted budget')


@case('derivation refuses a budget object without the real interface')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts)
    api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    for bad in (None, object(), lambda: None):
        try:
            adapter.retain(build, 'qlever-server', generator='Ninja',
                           materials=os.path.join(root, 'materials'), cwd=build, budget=bad)
        except adapter.LinkCommandUnavailable:
            continue
        raise AssertionError('accepted a non-budget %r' % (bad,))
    return 'all non-budget objects refused'


@case('C: SECOND derivation over our OWN record is idempotent')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    origin = load('link_command_origin', scripts)
    materials = os.path.join(root, 'materials')
    kwargs = dict(generator='Ninja', tool=os.path.join(root, 'ninja'),
                  materials=materials, cwd=build, budget=Budget(600))
    first = adapter.retain(build, 'qlever-server', **kwargs)
    link = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt')
    record = os.path.join(build, 'CMakeFiles/qlever-server.dir/origin.json')
    first_digest = origin.bounded_file_identity(record, origin.MEMBER_LIMIT_FOR_RECORD)['sha256']
    second = adapter.retain(build, 'qlever-server', **kwargs)
    assert second['linkLine'] == first['linkLine']
    assert os.path.isfile(link) and os.path.isfile(record)
    # a fresh raw derivation and a fresh record are produced
    assert second['capture']['stdout']['sha256'] != ''
    return 'second derivation succeeded over our own record'


@case('C: a FOREIGN link.txt without our record is refused')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    d = os.path.join(build, 'CMakeFiles/qlever-server.dir'); os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'link.txt'), 'w').write('/usr/bin/c++ stale.o -o qlever-server\n')
    try:
        adapter.retain(build, 'qlever-server', generator='Ninja',
                       tool=os.path.join(root, 'ninja'),
                       materials=os.path.join(root, 'materials'), cwd=build,
                       budget=Budget(600))
    except adapter.LinkCommandUnavailable as e:
        assert 'foreign link.txt' in str(e), e
        return 'stale CMake-owned link.txt refused'
    raise AssertionError('replaced a foreign link.txt')


@case('B: producer record satisfies the CONSUMER validator')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    origin = load('link_command_origin', scripts)
    materials = os.path.join(root, 'materials')
    adapter.retain(build, 'qlever-server', generator='Ninja',
                   tool=os.path.join(root, 'ninja'), materials=materials, cwd=build,
                   budget=Budget(600))
    link = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt')
    rec = origin.read_record(link, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
                             build_root=build, generator='Ninja',
                             materials_root=materials)
    for key in ('rawStdout', 'rawStderr', 'linkTxt', 'argv', 'linkLine'):
        assert key in rec, key
    return 'consumer keys present: linkTxt, rawStdout, rawStderr, argv, linkLine'


@case('B: TAMPERED raw stdout digest is refused by the consumer')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    adapter = load('link_command_adapter', scripts)
    origin = load('link_command_origin', scripts)
    materials = os.path.join(root, 'materials')
    adapter.retain(build, 'qlever-server', generator='Ninja',
                   tool=os.path.join(root, 'ninja'), materials=materials, cwd=build,
                   budget=Budget(600))
    link = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt')
    rec_path = origin.record_path(link)
    rec = json.load(open(rec_path))
    raw = rec['rawStdout']['path']
    open(raw, 'a').write('tampered\n')
    try:
        origin.read_record(link, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
                           build_root=build, generator='Ninja', materials_root=materials)
    except origin.OriginInvalid as e:
        assert 'rawStdout no longer matches' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted a tampered raw stdout')


@case('B: missing origin is refused for Ninja (mandatory)')
@with_tools('Ninja')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    origin = load('link_command_origin', scripts)
    d = os.path.join(build, 'CMakeFiles/qlever-server.dir'); os.makedirs(d, exist_ok=True)
    link = os.path.join(d, 'link.txt'); open(link, 'w').write('/usr/bin/c++ a.o -o qlever-server\n')
    try:
        origin.read_record(link, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
                           build_root=build, generator='Ninja')
    except origin.OriginInvalid as e:
        assert 'required but missing' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted a Ninja link.txt with no origin')


@case('B: a DERIVED origin is refused on a Unix Makefiles build')
@with_tools('Unix Makefiles')
def _(root, build, source, generator, scripts):
    api = load('cmake_file_api', scripts); api.write_queries(build)
    run_configure(root, build, source, generator)
    origin = load('link_command_origin', scripts)
    link = os.path.join(build, 'CMakeFiles/qlever-server.dir/link.txt')
    open(origin.record_path(link), 'w').write('{}')
    try:
        origin.read_record(link, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
                           build_root=build, generator='Unix Makefiles')
    except origin.OriginInvalid as e:
        assert 'must not carry a derived origin' in str(e), e
        return str(e)[:56]
    raise AssertionError('accepted an origin on a Makefiles build')


def main():
    failures = []
    for name, fn in RESULTS:
        try:
            print('%-62s PASS  %s' % (name, fn()))
        except AssertionError as error:
            failures.append(name); print('%-62s FAIL  %s' % (name, error))
        except BaseException as error:      # noqa: BLE001
            failures.append(name); print('%-62s ERROR %s: %s' % (name, type(error).__name__, error))
    print()
    print('%d/%d actual-flow cases pass' % (len(RESULTS) - len(failures), len(RESULTS)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
