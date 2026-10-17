"""One fixed SDK RUN registry shared by PID1 execution and image collection."""
import importlib.util
import os
from pathlib import Path
from types import MappingProxyType
from typing import NamedTuple

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('sdk_run_guard',HERE/'sdk-subreaper-guard.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)
MATERIALS=Path('/opt/qlever-sdk/materials')

class OwnedRun(NamedTuple):
    receipt: str
    command: tuple[str,...]

RUNS=MappingProxyType({
    'build':OwnedRun('owner-build.guard.json',('bash','-ceu',
        'python3 /components/qlever/scripts/sdk-inner-materials.py build\n'
        'test -f /opt/qlever-sdk/build/.xpod-build-contract.json\n'
        'test -f /opt/qlever-sdk/build/CMakeFiles/qlever-server.dir/link.txt\n'
        'test -f /opt/qlever-sdk/profile/inputs.json\n'
        'rm -rf /var/lib/apt/lists/*')),
    'linked':OwnedRun('owner-linked.guard.json',('bash','-ceu',
        'apt-get -o Acquire::AllowInsecureRepositories=false update\n'
        'apt-get -o APT::Get::AllowUnauthenticated=false install -y --no-install-recommends nodejs\n'
        'python3 /components/qlever/scripts/sdk-inner-materials.py linked')),
})

def main(role):
    recipe=RUNS[role]
    return guard.run(list(recipe.command),MATERIALS/recipe.receipt,
                     float(os.environ['XPOD_QLEVER_SDK_DEADLINE_UNIX']),emit_receipt=True)

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('role',choices=list(RUNS));args=parser.parse_args()
    raise SystemExit(main(args.role))
