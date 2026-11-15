"""Finite, duplex transport for the existing QLever smoke protocol.

No query schema, ABI decision, Docker operation or qualification lives here.
The caller supplies its existing absolute monotonic deadline and byte ledger.
"""
import os
import math
import json
import selectors
import signal
import subprocess
import time

class SmokeSession:
    def __init__(self, argv, *, parent_deadline, byte_limit, reserve, cleanup_seconds=2):
        if not isinstance(byte_limit, int) or isinstance(byte_limit, bool) or byte_limit < 1:
            raise ValueError('positive transport byte bound required')
        if (isinstance(parent_deadline,bool) or not isinstance(parent_deadline,(int,float)) or
            not math.isfinite(parent_deadline) or not 0 < parent_deadline-time.monotonic() <= 120):
            raise ValueError('finite existing parent deadline required')
        if isinstance(cleanup_seconds,bool) or not isinstance(cleanup_seconds,(int,float)) or not math.isfinite(cleanup_seconds):
            raise ValueError('finite cleanup reservation required')
        if not 0 < cleanup_seconds < parent_deadline-time.monotonic():
            raise ValueError('cleanup must fit the existing parent window')
        self.parent_deadline=parent_deadline
        self.end=parent_deadline-cleanup_seconds
        self.limit=byte_limit
        self.reserve=reserve
        self.used=0
        self.raw={key:bytearray() for key in ('stdin','stdout','stderr')}
        self.buffer=bytearray()
        self.pending=bytearray()
        self.eof=set()
        self.closed=False
        self.cleanup=None
        self.selector=selectors.DefaultSelector()
        try:
            self.process=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE,start_new_session=True)
        except BaseException:
            self.selector.close()
            raise
        self.pgid=self.process.pid
        try:
            for role in ('stdin','stdout','stderr'):
                stream=getattr(self.process,role)
                os.set_blocking(stream.fileno(),False)
                if role!='stdin':self.selector.register(stream,selectors.EVENT_READ,role)
        except BaseException:
            try:self.close()
            except BaseException:pass
            raise

    def check(self):
        if time.monotonic()>=self.end:raise TimeoutError('existing parent operation window exhausted')

    def charge(self, count):
        if self.used+count>self.limit:raise ValueError('combined smoke transport byte bound exhausted')
        self.reserve(count)
        self.used+=count

    def pump(self):
        self.check()
        for key,_ in self.selector.select(min(0.1,self.end-time.monotonic())):
            self.check()
            if key.data=='stdin':
                count=os.write(key.fd,self.pending[:65536])
                if count<=0:raise OSError('stdin made no progress')
                self.raw['stdin'].extend(self.pending[:count])
                del self.pending[:count]
                if not self.pending:self.selector.unregister(key.fileobj)
            else:
                # One overflow byte is diagnostic only; it is never retained.
                block=os.read(key.fd,min(65536,max(1,self.limit-self.used+1)))
                if not block:
                    self.eof.add(key.data);self.selector.unregister(key.fileobj)
                    continue
                self.charge(len(block))
                self.raw[key.data].extend(block)
                if key.data=='stdout':self.buffer.extend(block)

    def write(self, data):
        self.check()
        if not isinstance(data,bytes) or not data:raise ValueError('nonempty actual stdin bytes required')
        self.charge(len(data));self.pending.extend(data)
        self.selector.register(self.process.stdin,selectors.EVENT_WRITE,'stdin')
        while self.pending:self.pump()

    def readline(self):
        while True:
            self.check()
            offset=self.buffer.find(b'\n')
            if offset>=0:
                line=bytes(self.buffer[:offset+1]);del self.buffer[:offset+1];return line
            if 'stdout' in self.eof:raise EOFError('protocol stream closed before a complete line')
            self.pump()

    def finish(self):
        self.check()
        if self.pending:raise ValueError('unflushed protocol stdin')
        self.process.stdin.close()
        while self.eof!={'stdout','stderr'} or self.process.poll() is None:self.pump()
        if self.buffer:raise ValueError('unexpected trailing protocol stdout')
        return self.process.returncode

    def close(self):
        if self.closed:return
        errors=[]
        receipt=dict(pgid=self.pgid,signalAttempted=False,actualRootWait=False,
                     ownedGroupAbsent=False,parentDeadlineMonotonic=self.parent_deadline,
                     cleanupErrors=[])
        try:
            receipt['signalAttempted']=True
            try:os.killpg(self.pgid,signal.SIGKILL)
            except ProcessLookupError:pass
            except BaseException as error:errors.append(error)
            try:
                remaining=self.parent_deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('parent cleanup window exhausted')
                self.process.wait(timeout=remaining)
                receipt['actualRootWait']=True
                receipt['actualRootReturnCode']=self.process.returncode
            except BaseException as error:errors.append(error)
            while True:
                try:os.killpg(self.pgid,0)
                except ProcessLookupError:
                    receipt['ownedGroupAbsent']=True
                    break
                except BaseException as error:
                    errors.append(error)
                    break
                remaining=self.parent_deadline-time.monotonic()
                if remaining<=0:
                    errors.append(TimeoutError('owned group absence not observed before parent end'))
                    break
                # This is the original remaining cleanup interval, never a new window.
                time.sleep(min(0.01,remaining))
        finally:
            self.selector.close()
            for role in ('stdin','stdout','stderr'):
                try:getattr(self.process,role).close()
                except BaseException as error:errors.append(error)
            self.closed=True
            receipt['cleanupErrors']=[type(error).__name__ for error in errors]
            self.cleanup=receipt
        if errors:raise errors[0]

    def __enter__(self):return self

    def __exit__(self, kind, value, traceback):
        try:self.close()
        except BaseException:
            if kind is None:raise
        return False

class SmokeProcess:
    """The existing smoke's text-pipe interface, backed by one finite session."""
    def __init__(self, argv, *, expected_abi=None, pre_shutdown_hook=None, **limits):
        if expected_abi is not None and (type(expected_abi) is not dict or set(expected_abi)!=
            {'abiVersion','adapterAbiVersion','physicalBackendAbiVersion'} or
            any(type(value) is not int or value<1 for value in expected_abi.values())):
            raise ValueError('exact source-derived ABI declarations required')
        if pre_shutdown_hook is not None and not callable(pre_shutdown_hook):
            raise ValueError('actual synchronous pre-shutdown hook required')
        self.session=SmokeSession(argv,**limits)
        self.stdin=self
        self.stdout=self
        self.expected_abi=dict(expected_abi) if expected_abi is not None else None
        self.ready_checked=False
        self.pre_shutdown_hook=pre_shutdown_hook
        self.pre_shutdown_done=False

    def write(self, text):
        if not isinstance(text,str):raise TypeError('text protocol input required')
        raw=text.encode('utf-8')
        # The existing exact shutdown JSON is the single deterministic point
        # after all queries and before the process can exit. The hook runs
        # synchronously on this thread; its failure prevents shutdown bytes.
        if self.pre_shutdown_hook is not None and not self.pre_shutdown_done:
            try:
                value=json.loads(raw)
            except (TypeError,ValueError):
                value=None
            if isinstance(value,dict) and value.get('type')=='shutdown':
                self.session.check()
                self.pre_shutdown_hook()
                self.session.check()
                self.pre_shutdown_done=True
        self.session.write(raw)
        return len(text)

    def flush(self):
        # write() already pumps until every queued byte reaches the actual pipe.
        self.session.check()

    def read_protocol_line(self):
        text=self.session.readline().decode('utf-8')
        if self.expected_abi is not None and not self.ready_checked:
            ready=json.loads(text)
            if (not isinstance(ready,dict) or ready.get('type')!='ready' or
                any(type(ready.get(key)) is not int or ready[key]!=value
                    for key,value in self.expected_abi.items())):
                raise ValueError('actual ready differs from immutable ABI declarations')
            self.ready_checked=True
        return text

    def communicate(self, timeout=None):
        # The legacy helper passes relative timeout values. They never create
        # another timer: every operation uses the original supplied end.
        if not self.session.closed:self.session.finish()
        return '',bytes(self.session.raw['stderr']).decode('utf-8')

    def kill(self):self.session.close()

    @property
    def returncode(self):return self.session.process.returncode

    def __enter__(self):return self

    def __exit__(self,*failure):return self.session.__exit__(*failure)
