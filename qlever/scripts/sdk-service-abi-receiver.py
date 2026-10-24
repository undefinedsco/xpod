"""Pure replay of the existing command builders, never a Docker executor.

The caller authenticates all source snapshots. Only named existing function ASTs
and their literal constants are compiled; no second command/security table lives
here. SnapshotPath supplies an already-proved seed witness to the same builder's
filesystem preconditions. It makes no claim about this receiver's filesystem.
"""
import ast
import json
import re
import stat
import types
from pathlib import PurePosixPath


def need(value, why):
    if not value:
        raise ValueError('Service ABI command replay: ' + why)


def selected(raw, names, namespace, *, parent=None):
    tree = ast.parse(raw)
    if parent:
        parents = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == parent]
        need(len(parents) == 1, 'unique existing parent function')
        nodes = parents[0].body
    else:
        nodes = tree.body
    chosen = []
    for name in names:
        matching = [node for node in nodes if
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name or
            isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
        need(len(matching) == 1, 'unique existing function/constant: ' + name)
        chosen.append(matching[0])
    exec(compile(ast.Module(body=chosen, type_ignores=[]), '<retained-existing-command-source>', 'exec'), namespace)


def replay(sources, record, seed_size, output_root):
    need(set(sources) == {'image', 'binding', 'pack', 'direct', 'collector', 'seed'}, 'exact command source closure')
    need(isinstance(output_root, str) and output_root.startswith('/') and str(PurePosixPath(output_root)) == output_root
         and not any(part in ('.', '..', '') for part in output_root.split('/')[1:]) and ',' not in output_root,
         'canonical actual output root')
    need(type(seed_size) is int and 0 < seed_size <= 8*1024**2, 'bounded proved seed witness')
    common = dict(need=need, re=re, json=json, META=1024**2)
    binding = dict(common)
    selected(sources['binding'], ['local_docker'], binding)
    pack = dict(common)
    selected(sources['pack'], ['OUTPUT_PACK_ROLE', 'OUTPUT_PACK_PHASE_ROLE', 'OUTPUT_PACK_BODY_ROLE'], pack)
    image = dict(common, outer=types.SimpleNamespace(binding=types.SimpleNamespace(**binding)), pack_bindings=types.SimpleNamespace(**pack))
    image_constants = ['RUNTIME_ROOTS', 'RUNTIME_ROLES'] if any(isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'RUNTIME_ROLES' for target in node.targets) for node in ast.parse(sources['image']).body) else []
    selected(sources['image'], ['OUTPUT_INSPECT_TEMPLATE', 'OUTPUT_LABEL', 'OUTPUT_ROLES', 'OUTPUT_PACK_ROLE', 'OUTPUT_PACK_PHASE_ROLE', 'OUTPUT_PACK_BODY_ROLE', 'exact_image', 'output_image_command', 'inspect_output_container'] + image_constants, image)
    images = types.SimpleNamespace(**image)

    class SnapshotPath(PurePosixPath):
        def resolve(self, strict=False): return self
        def is_dir(self): return self == scratch
        def iterdir(self):
            need(self == scratch, 'only the proved seed directory is replayed')
            return iter([self/'abi.sqlite'])
        def lstat(self):
            need(self == scratch/'abi.sqlite', 'only the proved seed is replayed')
            return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_size=seed_size)

    nonce, name, cid = (record[key] for key in ('ownerNonce', 'containerName', 'containerId'))
    scratch = SnapshotPath(output_root)/(name+'-scratch')
    direct = dict(common, Path=SnapshotPath, stat=stat)
    selected(sources['direct'], ['RUNTIME', 'command'], direct)
    collector = dict(common)
    selected(sources['collector'], ['TMPFS_OPTIONS', 'NATIVE_RUNTIME', 'FIXED_BOOTSTRAP', 'command_for'], collector)
    args = (types.SimpleNamespace(**direct), images)
    expected = [collector['command_for'](*args, role, record['imageReferenceByDigest'], name, nonce, cid, scratch)
                for role in ('create', 'inspect', 'execute', 'cleanup-inspect', 'cleanup-remove', 'cleanup-confirm-absent')]
    # The successful path contains a second terminal inspect before cleanup.
    expected.insert(3, expected[1])
    nested = dict(collector, image_commands=images, image=record['imageReferenceByDigest'], config=record['configDigest'],
                  cid=cid, name=name, nonce=nonce, scratch=scratch)
    selected(sources['collector'], ['inspect'], nested, parent='collect')
    return expected, nested['inspect'], images.inspect_output_container


def inspect_request(request):
    import base64
    need(set(request) == {'sources', 'record', 'outputs', 'seedBytes', 'outputRoot', 'receipts'}, 'exact command replay request')
    sources = {key: base64.b64decode(value, validate=True) for key, value in request['sources'].items()}
    need(all(len(raw) <= 1024**2 for raw in sources.values()), 'bounded complete command sources')
    # Derive the maximum operation end from the sole producer expression,
    # evaluated at actual receipt start (which is no earlier than its setup).
    # No parallel 5/15/120-second budget table is maintained by the receiver.
    def end_expression(raw, function, target, nested=None):
        functions = [node for node in ast.parse(raw).body if isinstance(node, ast.FunctionDef) and node.name == function]
        need(len(functions) == 1, 'unique producer deadline function')
        node = functions[0]
        if nested:
            matches = [item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == nested]
            need(len(matches) == 1, 'unique nested producer deadline function')
            node = matches[0]
        values = [item.value for item in ast.walk(node) if isinstance(item, ast.Assign)
                  and any(isinstance(name, ast.Name) and name.id == target for name in item.targets)]
        need(len(values) == 1, 'unique producer deadline expression')
        return compile(ast.Expression(body=values[0]), '<retained-producer-deadline-expression>', 'eval')
    def interval(receipt, expression, cleanup=False):
        start = int(receipt['startedMonotonicNs'])/10**9
        namespace = dict(budget=types.SimpleNamespace(end=float(receipt['existingParentDeadline'])),
                         time=types.SimpleNamespace(monotonic=lambda:start), cleanup=cleanup)
        maximum = eval(expression, namespace)
        need(int(receipt['operationDeadlineMonotonicNs']) <= int(maximum*10**9),
             'operation exceeds the sole actual producer deadline expression')
    receipts = request['receipts']
    need(isinstance(receipts, list) and len(receipts) == 7, 'complete seed and CID control receipts')
    interval(receipts[0], end_expression(sources['seed'], 'generate', 'end'))
    stage_end = end_expression(sources['collector'], 'collect', 'end', 'stage')
    for receipt, stage in zip(receipts[1:], request['record']['stages']):
        interval(receipt, stage_end, stage['role'].startswith('cleanup-'))
    host = request['record']['session']['observation']
    interval(dict(host, existingParentDeadline=receipts[0]['existingParentDeadline']),
             end_expression(sources['collector'], 'collect', 'protocol_end'))
    record = request['record']
    commands, inspect, inspect_base = replay(sources, record, request['seedBytes'], request['outputRoot'])
    roles = ['create', 'inspect', 'inspect', 'cleanup-inspect', 'cleanup-remove', 'cleanup-confirm-absent']
    need([row['role'] for row in record['stages']] == roles, 'complete successful owned CID control order')
    expected = commands[:2] + commands[3:]
    need([row['command'] for row in record['stages']] == expected
         and record['session']['observation']['command'] == commands[2], 'same sole command builder outputs')
    outputs = [base64.b64decode(value, validate=True) for value in request['outputs']]
    need(len(outputs) == len(roles) and all(len(raw) <= 1024**2 for raw in outputs), 'complete bounded control stdout originals')
    need(outputs[0] == (record['containerId']+'\n').encode(), 'actual create CID differs')
    inspect(outputs[1], before=True)
    inspect(outputs[2])
    inspect_base(outputs[3], record['imageReferenceByDigest'], record['configDigest'], record['containerId'],
                 record['containerName'], record['ownerNonce'], require_never_started=False)
    need(outputs[4].decode().strip() == record['containerId'] and outputs[5] == b'', 'actual owned removal/absence differs')
    return dict(commandReplayVerified=True)
