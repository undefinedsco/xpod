"""Controlled real Linux PID1 guard recipes; no SDK/source qualification.

Each recipe is launched by sdk-subreaper-guard.py as PID1, not by a shell that
catches the guard's exit. Negative cases must keep a nonzero guard exit.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
FLAGS=['-f','-ttt','-yy','-s','131072','-e','trace=%process,%file,%memory,%desc,%%stat',
       '-e','abbrev=execve,execveat','-e','raw=read,write,pread64,pwrite64,readv,writev,preadv,pwritev,preadv2,pwritev2']

def write(path,value):
    path=Path(path);temporary=path.with_name(path.name+'.pending')
    temporary.write_text(json.dumps(value,sort_keys=True)+'\n');temporary.replace(path)

def require_guard():
    if sys.platform!='linux' or b'/sdk-subreaper-guard.py' not in Path('/proc/1/cmdline').read_bytes():
        raise RuntimeError('Controlled fixture requires actual guard PID1; refuses host PID1 signalling')

def tracee(out,term_cleanup):
    require_guard();child=os.fork()
    if child==0:
        os.setsid();write(out/'escaped-child.birth.json',dict(pid=os.getpid(),ppid=os.getppid(),pgid=os.getpgrp(),pidNamespace=os.readlink('/proc/self/ns/pid'),startedUnixNs=str(time.time_ns())))
        if term_cleanup:
            until=time.monotonic()+10
            while os.getppid()!=1:
                if time.monotonic()>=until:raise RuntimeError('Actual reparent to guard absent')
                time.sleep(.0002)
            # Reparent occurs only after the guard began killing the parent
            # following top-recipe exit. Deliver TERM during cleanup, not startup.
            os.kill(1,signal.SIGTERM)
        time.sleep(10);os._exit(0)
    os.waitpid(child,0)

def recipe(scenario,out):
    require_guard();out=Path(out).resolve();out.mkdir(parents=True,exist_ok=False)
    temporary=out/'tmp';temporary.mkdir();os.environ['TMPDIR']=str(temporary)
    if not shutil.which('strace') or not shutil.which('g++'):raise RuntimeError('Existing real strace/g++ required')
    if scenario=='normal':
        source=out/'main.cpp';source.write_text('int main(){return 0;}\n');binary=out/'main'
        argv=[shutil.which('strace'),*FLAGS,'-o',str(out/'trace.raw'),'--',shutil.which('g++'),'-flto',str(source),'-o',str(binary)]
        with (out/'stdout.raw').open('xb') as stdout,(out/'stderr.raw').open('xb') as stderr:
            result=subprocess.run(argv,stdout=stdout,stderr=stderr,check=False)
        write(out/'command.original.json',dict(argv=argv,returnCode=result.returncode,scope='controlled tiny strace compile diagnostic'))
        if result.returncode:raise SystemExit(result.returncode)
        result=subprocess.run([str(binary)],check=False);write(out/'binary-exit.original.json',dict(returnCode=result.returncode));raise SystemExit(result.returncode)
    command=[shutil.which('strace'),*FLAGS,'-o',str(out/'trace.raw'),'--',sys.executable,'-B',str(Path(__file__).resolve()),'--tracee',str(out)]
    if scenario=='term-cleanup':command.append('--term-cleanup')
    with (out/'stdout.raw').open('xb') as stdout,(out/'stderr.raw').open('xb') as stderr:
        tracer=subprocess.Popen(command,stdout=stdout,stderr=stderr)
        until=time.monotonic()+3
        while not (out/'escaped-child.birth.json').exists():
            if tracer.poll() is not None or time.monotonic()>until:raise RuntimeError('Controlled tracee failed to start')
            time.sleep(.001)
        if scenario=='deadline':
            # The guard must interrupt and kill this whole tree before its ten
            # second child sleep finishes. No new timeout is granted here.
            tracer.wait();raise SystemExit('Deadline guard unexpectedly allowed full child sleep')
        tracer.kill();code=tracer.wait(timeout=2)
        write(out/'tracer-kill.original.json',dict(argv=command,tracerPid=tracer.pid,tracerActualWait=True,tracerReturnCode=code,topRecipeExit=0,
            scope='Intentional bad recipe: leaves live adopted tracees; guard must fail after actual forced cleanup'))
        # Deliberately return zero; this must not turn cleanup into execution success.

if __name__=='__main__':
    hard=resource.getrlimit(resource.RLIMIT_FSIZE)[1];bound=16*1024**2 if hard==resource.RLIM_INFINITY else min(hard,16*1024**2)
    resource.setrlimit(resource.RLIMIT_FSIZE,(bound,bound))
    parser=argparse.ArgumentParser();parser.add_argument('--scenario',choices=['normal','crash','deadline','term-cleanup']);parser.add_argument('--out',type=Path);parser.add_argument('--tracee',type=Path);parser.add_argument('--term-cleanup',action='store_true');args=parser.parse_args()
    if args.tracee:tracee(args.tracee,args.term_cleanup)
    elif args.scenario and args.out:recipe(args.scenario,args.out)
    else:raise SystemExit('Controlled fixture recipe required')
