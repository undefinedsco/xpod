"""Native bounded command stages using the existing SDK child/supervisor protocol."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'scripts/agentfs-native-ci'))
from supervise import run_stage
spec = importlib.util.spec_from_file_location('native_command_materials', HERE / 'sdk-command-materials.py')
materials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(materials)


def stage_factory(out, *, maximum, deadline, check):
    out = Path(out)
    stages = out / 'stages'
    stages.mkdir(mode=0o700)
    rows = []
    def size():
        total = 0
        for root, dirs, names in os.walk(out):
            if any((Path(root) / name).is_symlink() for name in dirs):
                raise ValueError('native stage directory link')
            for name in names:
                path = Path(root) / name
                if path.is_symlink() or not path.is_file():
                    raise ValueError('native stage non-regular original')
                total += path.stat().st_size
        return total
    def stage(name, command, cwd):
        check()
        if not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
            raise ValueError('native stage name')
        remaining = maximum - size()
        if remaining <= 3 * 65536:
            raise ValueError('native stage remaining bytes')
        directory = stages / name
        directory.mkdir(mode=0o700)
        def free(path):
            check()
            if size() > maximum - 65536:
                raise ValueError('native command shared original budget exceeded')
            return shutil.disk_usage(path)
        receipt, raw = run_stage(name,
            [sys.executable, '-B', str(HERE / 'sdk-command-materials.py'),
             '--exec-child', str(directory), json.dumps(command)],
            stages, cwd, environment={k: v for k, v in os.environ.items()
                                      if k not in ('GH_TOKEN', 'GITHUB_TOKEN')},
            target=out, free=free, fresh_bytes=2 * 1024**3, stop_bytes=2 * 1024**3,
            poll_seconds=.05, absolute_deadline=deadline,
            raw_limit_bytes=65536, receipt_limit_bytes=65536)
        check()
        if not (directory / 'command.receipt.json').is_file():
            raise ValueError('native command did not create an actual closed receipt: ' + name)
        actual = json.loads((directory / 'command.receipt.json').read_text())
        if (receipt['exit'] != 0 or receipt['signal'] is not None or receipt['resourceStop']
            or receipt.get('supervisorError') or receipt.get('cleanupErrors')
            or not receipt['actualWait'] or not receipt['ownedGroupAbsentAfterWait']
            or not receipt['rawClosedBeforeHash'] or raw is None
            or actual['exit'] != 0 or actual['signal'] is not None
            or not actual['actualWait'] or actual['pgid'] != receipt['pgid']):
            raise ValueError('native actual closed command failed: ' + name)
        for role in ('stdout', 'stderr'):
            if materials.ref(directory / actual[role]['path'], directory) != actual[role]:
                raise ValueError('native stage stdio changed')
        if size() > maximum:
            raise ValueError('native closed stage original budget exceeded')
        row = dict(name=name, receipt=materials.ref(directory/'command.receipt.json',out),
                   stdout=materials.ref(directory/'stdout.raw',out),
                   stderr=materials.ref(directory/'stderr.raw',out),
                   supervisionReceipt=materials.ref(stages/(name+'.receipt.json'),out),
                   supervisionRaw=materials.ref(stages/(name+'.raw.log'),out),
                   inputs=[], outputs=[])
        rows.append(row)
        return row
    return stage, rows
