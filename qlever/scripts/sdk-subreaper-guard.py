"""PID1 Linux child-tree guard: kernel child pidfds, never JSON PID/PGID kills.

A private subreaper owns the entire RUN. Namespace-init exit is the final
lifecycle boundary if this process is killed. This file issues no SDK capability.
"""
import ctypes
import json
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('guard_execution_budget',HERE/'sdk-execution-budget.py')
budgets=importlib.util.module_from_spec(spec);spec.loader.exec_module(budgets)
MAX_ENTRIES=4096
METADATA=4*1024**2

def check(deadline):
    if time.monotonic()>=deadline:raise TimeoutError('Guard unique cleanup deadline')

def children(deadline):
    check(deadline)
    with (Path('/proc/self/task')/str(os.getpid())/'children').open('rb') as source:raw=source.read(METADATA+1)
    if len(raw)>METADATA:raise ValueError('Guard kernel child list byte bound')
    values=raw.split(None,MAX_ENTRIES)
    if len(values)>MAX_ENTRIES:raise ValueError('Guard kernel child entry bound')
    return [int(value) for value in values]

def reap(deadline):
    result=[]
    while True:
        check(deadline)
        try:pid,status=os.waitpid(-1,os.WNOHANG)
        except ChildProcessError:return result,True
        if pid==0:return result,False
        result.append(dict(pid=pid,waitStatus=status))
        if len(result)>MAX_ENTRIES:raise ValueError('Guard actual wait entry bound')

def terminate_owned(deadline):
    reaped=[];signalled=[]
    while True:
        check(deadline);rows,empty=reap(deadline);reaped.extend(rows)
        if len(reaped)>MAX_ENTRIES:raise ValueError('Guard cumulative wait entry bound')
        if empty:
            if children(deadline):raise RuntimeError('Guard kernel children/wait disagreement')
            return dict(reaped=reaped,signalledPidfds=signalled,actualEchild=True)
        for pid in children(deadline):
            check(deadline)
            try:fd=os.pidfd_open(pid,0)
            except ProcessLookupError:continue
            try:
                check(deadline)
                # ECHILD rejects a non-child even if its numeric PID was reused.
                try:state=os.waitid(os.P_PIDFD,fd,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                except ChildProcessError:continue
                if state is None:
                    signal.pidfd_send_signal(fd,signal.SIGKILL)
                    signalled.append(dict(pid=pid,signal=int(signal.SIGKILL),ownership='kernel-waitid-P_PIDFD-child'))
                    if len(signalled)>MAX_ENTRIES:raise ValueError('Guard pidfd signal entry bound')
            except ProcessLookupError:pass
            finally:os.close(fd)
        time.sleep(.005)

def write(path,value):
    size=0
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    with Path(path).open('x') as output:
        for text in json.JSONEncoder(sort_keys=True,ensure_ascii=True).iterencode(value):
            size+=len(text)
            if size>METADATA:raise ValueError('Guard metadata byte bound')
            output.write(text)

def run(command,receipt,deadline_unix,cleanup_seconds=3,emit_receipt=False):
    if sys.platform!='linux' or os.getpid()!=1:
        raise RuntimeError('Guard requires actual PID namespace init; no non-PID1 fallback')
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal') or not hasattr(os,'P_PIDFD'):
        raise RuntimeError('Linux pidfd/waitid support required; no PID-number fallback')
    budget=budgets.ExecutionBudget(deadline_unix)
    if not 0<cleanup_seconds<=5 or budget.remaining()<=cleanup_seconds:
        raise ValueError('Existing parent deadline with reserved cleanup grace required')
    global_end=budget.end;command_end=global_end-cleanup_seconds
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(36,1,0,0,0)!=0:raise OSError(ctypes.get_errno(),'Guard subreaper unavailable')
    if children(command_end):raise RuntimeError('Guard must begin with no preexisting children')
    started=time.time_ns();interrupted=[]
    def stop(signum,frame):interrupted.append(signum)
    for signum in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(signum,stop)
    signal.signal(signal.SIGCHLD,signal.SIG_DFL)
    namespace=os.readlink('/proc/self/ns/pid')
    child=subprocess.Popen(command);code=None;reason=None;cleanup=None;cleanup_deadline=None;error=None;child_namespace=None
    try:
        child_namespace=os.readlink('/proc/'+str(child.pid)+'/ns/pid')
        if child_namespace!=namespace:raise RuntimeError('Guard and initial inner process PID namespaces differ')
        while True:
            code=child.poll()
            if code is not None:break
            if interrupted:reason='guard-interrupted';break
            if time.monotonic()>=command_end:reason='guard-command-deadline';break
            time.sleep(.005)
        # Allocated exactly once and always inside the existing parent deadline.
        cleanup_deadline=min(global_end,time.monotonic()+cleanup_seconds)
        cleanup=terminate_owned(cleanup_deadline)
    except Exception as failure:
        reason=reason or 'guard-observation-or-cleanup-failed';error=type(failure).__name__+': '+str(failure)
    finally:
        if cleanup_deadline is None:
            cleanup_deadline=min(global_end,time.monotonic()+cleanup_seconds)
            try:cleanup=terminate_owned(cleanup_deadline)
            except Exception as failure:error=type(failure).__name__+': '+str(failure)
        # A failed cleanup is never retried with a fresh grace period. PID1 exits
        # nonzero and the kernel tears down the RUN namespace.
        if code is None and cleanup:
            waited=next((row for row in cleanup['reaped'] if row['pid']==child.pid),None)
            if waited is not None:
                code=os.waitstatus_to_exitcode(waited['waitStatus']);child.returncode=code
        if interrupted:reason=reason or 'guard-interrupted'
        if cleanup and cleanup['signalledPidfds']:reason=reason or 'live-descendant-after-command-exit'
        if code!=0:reason=reason or 'command-nonzero-or-wait-incomplete'
        if not cleanup:reason=reason or 'kernel-child-cleanup-incomplete'
        value=dict(schemaVersion=1,kind='linux-kernel-owned-subreaper-guard-original',command=command,
            guardPid=os.getpid(),guardPgid=os.getpgrp(),pidNamespace=namespace,topCommandPidNamespace=child_namespace,
            startedUnixNs=str(started),completedUnixNs=str(time.time_ns()),globalDeadlineUnix=deadline_unix,
            cleanupGraceSeconds=cleanup_seconds,cleanupDeadlineMonotonic=cleanup_deadline,
            topCommandPid=child.pid,topCommandActualWait=code is not None,topCommandReturnCode=code,
            observedSignals=interrupted,reason=reason,error=error,cleanup=cleanup,
            scope='Actual PID1/kernel child-tree mechanics only; no SDK/source/host PID acceptance')
        write(receipt,value)
        if emit_receipt:
            with Path(receipt).open('r') as original:
                for block in iter(lambda:original.read(65536),''):sys.stdout.write(block)
            sys.stdout.flush()
    return 0 if not interrupted and not error and reason is None and code==0 and cleanup and cleanup['actualEchild'] else 1

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--receipt',type=Path,required=True);parser.add_argument('--deadline-unix',type=float,required=True);parser.add_argument('--cleanup-seconds',type=float,default=3);parser.add_argument('--emit-receipt',action='store_true');parser.add_argument('command',nargs=argparse.REMAINDER);args=parser.parse_args()
    command=args.command[1:] if args.command and args.command[0]=='--' else args.command
    if not command:raise SystemExit('Guard command required')
    raise SystemExit(run(command,args.receipt,args.deadline_unix,args.cleanup_seconds,args.emit_receipt))
