"""Retain the qlever-server link command for the generator that actually ran.

Unix Makefiles already has a real CMake-owned
`CMakeFiles/qlever-server.dir/link.txt`; it is PRESERVED untouched and `make` is
never invoked (recursive/`$(shell)` evaluation can execute work even under `-n`).

Ninja has no such file. The link line comes from Ninja's own tool mode
(`-t commands -s <target>`) executed through the EXISTING SDK command leaf
`commands.capture(...)`, so this module inherits the real supervision: Popen via
`sdk-command-materials.py --exec-child`, inherited PGID, actual waitpid receipt,
closed raw streams, the SDK stream budget and the caller's deadline. No
`subprocess.run(capture_output=True)`, no invented byte-as-second timeout, no
separate stderr left unbounded.

The derived line is recorded through `link_command_origin`, the single schema
shared with the consumer (`sdk-inner-materials`).
"""
import importlib.util
import os
import shlex

HERE = os.path.dirname(os.path.abspath(__file__))
NINJA = 'ninja'
STAGE_NAME = 'link-command'


class LinkCommandUnavailable(RuntimeError):
    """No usable generator-owned link command. Never degrade, never guess."""


def _load(name, filename):
    """Load a sibling SDK module from this directory (or the staged siblings/
    copy used by the probe container, where the full R tree is absent)."""
    for directory in (HERE, os.path.join(HERE, 'siblings')):
        candidate = os.path.join(directory, filename)
        if os.path.isfile(candidate):
            break
    else:
        raise ImportError('SDK sibling module missing: ' + filename)
    module_spec = importlib.util.spec_from_file_location(name, candidate)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


# `sdk-command-materials.py` does `from supervise import ...`, so the sibling
# directory must be importable exactly as it is in the real SDK layout, where
# qlever/scripts is on the interpreter's path. No harness-only crutch here.
import sys as _sys
for _directory in (HERE, os.path.join(HERE, 'siblings')):
    if os.path.isdir(_directory) and _directory not in _sys.path:
        _sys.path.insert(0, _directory)

commands = _load('adapter_command_materials', 'sdk-command-materials.py')
origin = _load('adapter_link_origin', 'link_command_origin.py')

_STAGE_COUNTER = {}


def _stage_name(materials):
    """A stage name unique to this derivation attempt.

    `commands.capture` creates `stages/<name>` fresh and refuses an existing one,
    so a repeat derivation must never reuse a name. The counter is keyed on the
    materials tree, which is where the stage directory actually lives.
    """
    key = os.path.abspath(materials)
    index = _STAGE_COUNTER.get(key, 0)
    while True:
        candidate = '%s-%d' % (STAGE_NAME, index)
        if not os.path.exists(os.path.join(key, 'stages', candidate)):
            _STAGE_COUNTER[key] = index + 1
            return candidate
        index += 1


def _load(name, filename):
    """Load a sibling SDK module from this directory, falling back to the
    staged `siblings/` copy used in the probe container where the full R tree is
    absent. In the real SDK layout the modules are siblings in qlever/scripts."""
    found = None
    for directory in (HERE, os.path.join(HERE, 'siblings')):
        path = os.path.join(directory, filename)
        if os.path.isfile(path):
            found = path
            break
    if found is None:
        raise ImportError('SDK sibling module missing: ' + filename)
    spec = importlib.util.spec_from_file_location(name, found)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# `sdk-command-materials.py` does `from supervise import ...`, so the sibling
# directory must be importable exactly as it is in the real SDK layout, where
# qlever/scripts is on the interpreter's path. No harness-only crutch here.
import sys as _sys
for _directory in (HERE, os.path.join(HERE, 'siblings')):
    if os.path.isdir(_directory) and _directory not in _sys.path:
        _sys.path.insert(0, _directory)

commands = _load('adapter_command_materials', 'sdk-command-materials.py')
origin = _load('adapter_link_origin', 'link_command_origin.py')


def makefiles_link_txt(build, target='qlever-server'):
    return os.path.join(build, 'CMakeFiles', target + '.dir', 'link.txt')


def preserve_makefiles(build, target='qlever-server'):
    """Unix Makefiles: keep CMake's own original, never run make."""
    path = makefiles_link_txt(build, target)
    if os.path.islink(path) or not os.path.isfile(path):
        raise LinkCommandUnavailable(
            'Unix Makefiles build must already contain the CMake-owned link.txt: ' + path)
    existing = origin.record_path(path)
    if os.path.isfile(existing):
        raise LinkCommandUnavailable(
            'CMake-authored link.txt must not carry a derived origin: ' + existing)
    return {
        'generator': 'Unix Makefiles',
        'origin': 'cmake-owned',
        'executedMake': False,
        'linkTxt': origin.bounded_file_identity(path, origin.MEMBER_LIMIT_FOR_RECORD),
        'scope': 'CMake wrote link.txt itself; no make invocation',
    }


def _validate_link_line(link_line, target):
    if not link_line or '\x00' in link_line:
        raise LinkCommandUnavailable('link line is empty or unsafe')
    try:
        tokens = shlex.split(link_line)
    except ValueError as error:
        raise LinkCommandUnavailable('link line is not shell-parseable: %s' % error)
    if not tokens:
        raise LinkCommandUnavailable('link line has no tokens')
    if tokens.count('-o') != 1:
        raise LinkCommandUnavailable('link line must contain exactly one -o')
    index = tokens.index('-o')
    if index + 1 >= len(tokens) or tokens[index + 1] != target:
        raise LinkCommandUnavailable('link line does not produce %r' % target)
    objects = [t for t in tokens if t.endswith('.o') or t.endswith('.obj')]
    if not objects:
        raise LinkCommandUnavailable('link line contains no object files')
    if len(objects) != len(set(objects)):
        raise LinkCommandUnavailable('link line repeats an object file')
    libraries = [t for t in tokens if t.startswith('-l') or t.endswith('.a')
                 or '.so' in t or '.dylib' in t]
    if not libraries:
        raise LinkCommandUnavailable('link line contains no library inputs')
    compiler = tokens[0]
    if not (os.path.isabs(compiler) or compiler.endswith(('++', 'cc', 'gcc', 'clang'))):
        raise LinkCommandUnavailable('link line does not start with a compiler: ' + compiler)
    return tokens, objects, libraries


_NOOP_TOKENS = (':', 'true')


def _split_top_level_and(line):
    parts, current, quote, escaped = [], [], None, False
    index = 0
    while index < len(line):
        character = line[index]
        if escaped:
            current.append(character); escaped = False; index += 1; continue
        if character == '\\':
            current.append(character); escaped = True; index += 1; continue
        if quote:
            current.append(character)
            if character == quote:
                quote = None
            index += 1; continue
        if character in ('\'', '"'):
            quote = character; current.append(character); index += 1; continue
        if line.startswith('&&', index):
            parts.append(''.join(current)); current = []; index += 2; continue
        current.append(character); index += 1
    parts.append(''.join(current))
    return [part.strip() for part in parts]


def unwrap_noop_shell(line):
    """Strip only KNOWN no-op `:`/`true` fragments joined by top-level `&&`."""
    parts = [part for part in _split_top_level_and(line) if part]
    if not parts:
        raise LinkCommandUnavailable('link line is empty after unwrapping')
    kept = [part for part in parts if part not in _NOOP_TOKENS]
    if len(kept) != 1:
        raise LinkCommandUnavailable(
            'link line is not a single command after removing known no-ops')
    return kept[0]


def retain_ninja(build, target='qlever-server', tool=NINJA, materials=None,
                 cwd=None, budget=None):
    """Ninja: capture the tool through the SDK leaf and record the derivation."""
    if materials is None or cwd is None:
        raise LinkCommandUnavailable(
            'the real capture leaf requires materials and cwd')
    # Validate the budget interface explicitly: an object without the real
    # ExecutionBudget surface is a refusal, not an AttributeError later.
    for name in ('check', 'timeout', 'remaining'):
        if not callable(getattr(budget, name, None)):
            raise LinkCommandUnavailable(
                'the SDK ExecutionBudget is required (missing %s()); got %r'
                % (name, type(budget).__name__))
    build = os.path.abspath(build)
    link_txt = makefiles_link_txt(build, target)
    # A SECOND derivation over our OWN prior record must be idempotent: the
    # adapter owns both link.txt and its record, so it may replace them. An
    # existing file WITHOUT our own valid record is a foreign (e.g. stale
    # Makefiles) artifact and is refused.
    if os.path.exists(link_txt):
        try:
            origin.read_record(link_txt, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
                               build_root=build, generator='Ninja',
                               materials_root=materials)
        except origin.OriginInvalid as error:
            raise LinkCommandUnavailable(
                'refusing to replace a foreign link.txt without our own valid '
                'record: %s' % error)
    # The derivation IS the support probe: `-s` is requested unconditionally and
    # a Ninja that does not implement it exits non-zero, which the SDK capture
    # leaf turns into a refusal. There is no inferred version check and no
    # fallback to the whole dependency command chain.
    argv = [tool, '-C', build, '-t', 'commands', '-s', target]
    budget.check(120)
    remaining = budget.timeout(600, 120)     # raises TimeoutError on expiry
    try:
        result = commands.capture(_stage_name(materials), argv, materials, cwd,
                                  timeout=remaining,
                                  resource_profile='observation')
    except LinkCommandUnavailable:
        raise
    except TimeoutError:
        # The caller's deadline is NOT a lease/tool verdict: propagate unchanged
        # so the SDK driver sees its own budget expiry, exactly as elsewhere.
        raise
    except BaseException as error:
        raise LinkCommandUnavailable(
            'ninja -t commands -s failed or is unsupported; refusing to fall back '
            'to the whole dependency command chain: %s' % error)
    raw_stdout = os.path.join(materials, result['stdout']['path'])
    text = origin.bounded_original_bytes(
        raw_stdout, commands.RAW_LIMIT, LinkCommandUnavailable).decode('utf-8', 'replace')
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        raise LinkCommandUnavailable('ninja -t commands printed no commands')
    candidates = [line for line in lines
                  if (' -o ' + target + ' ' in ' ' + line + ' ')
                  or line.rstrip().endswith(' -o ' + target)]
    if len(candidates) != 1:
        raise LinkCommandUnavailable(
            'expected exactly one link line for %r among %d commands, found %d'
            % (target, len(lines), len(candidates)))
    raw_line = candidates[0].strip()
    link_line = unwrap_noop_shell(raw_line)
    tokens, objects, libraries = _validate_link_line(link_line, target)

    os.makedirs(os.path.dirname(link_txt), exist_ok=True)
    with open(link_txt, 'w') as handle:
        handle.write(link_line + '\n')
    record = origin.write_record(
        link_txt, generator='Ninja', argv=argv,
        raw=dict(stdout=raw_stdout, stderr=os.path.join(materials, result['stderr']['path'])),
        link_line=link_line, member_limit=origin.MEMBER_LIMIT_FOR_RECORD,
        build_root=build)
    return {
        'generator': 'Ninja',
        'origin': 'ninja-tool-introspection',
        'argv': argv,
        'capture': result,
        'rawCommandLine': raw_line,
        'linkLine': link_line,
        'unwrapped': raw_line != link_line,
        'objects': objects,
        'libraries': libraries,
        'record': origin.record_path(link_txt),
        'recordSHA256': record['linkTxt']['sha256'],
        'scope': ('PLANNED derivation from the generator tool output, captured '
                  'through the SDK command leaf; NOT execution proof'),
    }


def retain(build, target='qlever-server', generator=None, tool=NINJA,
           materials=None, cwd=None, budget=None):
    if generator == 'Unix Makefiles':
        return preserve_makefiles(build, target)
    if generator == 'Ninja':
        return retain_ninja(build, target, tool, materials, cwd, budget)
    raise LinkCommandUnavailable('unsupported generator: %r' % (generator,))
