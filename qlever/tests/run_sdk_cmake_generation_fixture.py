"""Real tiny CMake behavior diagnostic; requires existing cmake, make and g++.

Run against a read-only helper tree with a separate writable output directory.
This does not mint SDK origin/custody or reinterpret container PIDs as host PIDs.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

ROOT=Path(__file__).resolve().parents[2]

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def run(output):
    tools={name:shutil.which(name) for name in ['cmake','make','g++']}
    if not all(tools.values()):raise RuntimeError('Existing real cmake/make/g++ required; no install or simulated fallback')
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    source=output/'source';source.mkdir();build=output/'build';materials=output/'sdk/inner';materials.mkdir(parents=True)
    (source/'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(GenerationFixture LANGUAGES CXX)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(NUMBER 7)
configure_file(config.h.in "${CMAKE_CURRENT_BINARY_DIR}/config.h" @ONLY)
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated.h" CONTENT "#define GENERATED 11\\n")
add_custom_command(OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/custom.h"
 COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/generate.py" "${CMAKE_CURRENT_SOURCE_DIR}/input.txt" "${CMAKE_CURRENT_BINARY_DIR}/custom.h"
 DEPENDS generate.py input.txt VERBATIM)
add_executable(generation_fixture main.cpp "${CMAKE_CURRENT_BINARY_DIR}/custom.h")
target_include_directories(generation_fixture PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
''')
    (source/'config.h.in').write_text('#define CONFIGURED @NUMBER@\n')
    (source/'input.txt').write_text('13\n')
    (source/'generate.py').write_text('import pathlib,sys\npathlib.Path(sys.argv[2]).write_text("#define CUSTOM "+pathlib.Path(sys.argv[1]).read_text().strip()+"\\n")\n')
    (source/'main.cpp').write_text('#include "config.h"\n#include "generated.h"\n#include "custom.h"\nint main(){return CONFIGURED+GENERATED+CUSTOM==31?0:1;}\n')
    inner=load('generation_fixture_inner','sdk-inner-materials.py');generation=load('generation_fixture_materials','sdk-generation-materials.py')
    image=load('generation_fixture_image','sdk-image-originals.py');commands=inner.commands
    deadline=time.time()+5000;budget=inner.budget_module.ExecutionBudget(deadline)
    inner.EXECUTION_BUDGET=budget;inner.EXECUTION_RESERVE=4200;check=lambda:budget.check(4200)
    private_key='XPOD_QLEVER_SDK_DEADLINE_UNIX';previous=os.environ.get(private_key);os.environ[private_key]=str(deadline)
    stages=[]
    try:
        stages.append(commands.capture('configure',[sys.executable,'-B',str(ROOT/'qlever/scripts/sdk-generation-materials.py'),
            'configure',str(materials/'generation'),str(source),str(build),'--',tools['cmake'],'-S',str(source),'-B',str(build),
            '-G','Unix Makefiles','-DCMAKE_CXX_COMPILER='+tools['g++'],'-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'],materials,source,timeout=30,resource_profile='observation'))
        before_metadata=generation.snapshot(materials,build,'before',inner.archive_inputs,inner.file_identity,check)
        before={str(path.resolve()):inner.file_identity(path.resolve()) for directory in [source,build] for path in directory.rglob('*') if path.is_file() and not path.is_symlink()}
        inner.dump(materials/'inputs-before.json',before)
        stages.append(commands.capture('compile',[tools['cmake'],'--build',str(build),'--parallel','1'],materials,source,
            inputs=[commands.ref(materials/'inputs-before.json',materials),before_metadata],timeout=30,resource_profile='observation'))
        selected=inner.dependency_paths(build)
        inventory=inner.archive_inputs(selected,materials/'domains',before)
        inner.dump(materials/'inputs-after.json',inventory)
        after_metadata=generation.snapshot(materials,build,'after',inner.archive_inputs,inner.file_identity,check)
        final_ref,total=generation.finalize(materials,build,before_metadata,after_metadata,inventory,before,stages,check)
        stages.append(commands.capture('fixture-test',[str(build/'generation_fixture')],materials,source,timeout=10,resource_profile='observation'))
        public_ref=image.receiver_generation_collection(output/'sdk',final_ref)
        final=json.loads((materials/final_ref['path']).read_text());mapped=json.loads((materials/final['selectedInputs']['path']).read_text())
        rows={Path(row['originalPath']).name:row for row in mapped['files']}
        assert rows['config.h']['beforeObservation'] is not None
        assert rows['generated.h']['beforeObservation'] is not None
        assert rows['custom.h']['beforeObservation'] is None
        trace_path=materials/final['configureTrace']['path'];count=0;observed=set()
        with trace_path.open('rb') as trace:
            while True:
                line=trace.readline(generation.METADATA+1)
                if not line:break
                assert len(line)<=generation.METADATA
                record=json.loads(line);count+=1
                if record.get('cmd')=='configure_file':observed.add('configure_file')
                if record.get('cmd')=='add_custom_command':observed.add('add_custom_command')
                if record.get('cmd')=='file' and record.get('args',[None])[0]=='GENERATE':observed.add('file-GENERATE')
        assert observed=={'configure_file','file-GENERATE','add_custom_command'}
        original=(materials/final_ref['path']).read_bytes();public=json.loads((output/'sdk'/public_ref['path']).read_text())
        reference=public.pop('innerMaterials');assert (output/'sdk'/reference['path']).read_bytes()==original
        assert public==load('generation_fixture_upstream','sdk-upstream-source-materials.py').root_refs(final,'inner')
        report=dict(schemaVersion=1,scope='Real tiny CMake behavior diagnostic only; no SDK origin/custody/host-PGID acceptance',
            traceRecords=count,observedCommands=sorted(observed),generationMaterialBytes=total,collection=public_ref,
            fixtureTest=stages[-1],pending=final['pending'])
        (output/'diagnostic.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
        print(json.dumps(dict(report='diagnostic.json',scope=report['scope'],traceRecords=count,generationMaterialBytes=total)))
    finally:
        if previous is None:os.environ.pop(private_key,None)
        else:os.environ[private_key]=previous

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args();run(args.out)
