"""Reviewed Linux ptrace syscall-info primitives shared by the single backend."""
import ctypes
import importlib.util
import os
from pathlib import Path
import struct
spec=importlib.util.spec_from_file_location('sdk_generation_policy',Path(__file__).with_name('sdk-generation-multiprocess-bindings.py'));bindings=importlib.util.module_from_spec(spec);spec.loader.exec_module(bindings)
libc=ctypes.CDLL(None,use_errno=True);libc.ptrace.restype=ctypes.c_long
TRACEME=0;SYSCALL=24;SETOPTIONS=0x4200;INFO=0x420e;PEEKDATA=2
OPTIONS=1|0x00100000 # TRACESYSGOOD|EXITKILL
MAX=1024*1024
class SysInfo(ctypes.Structure):
    _fields_=[('op',ctypes.c_ubyte),('pad',ctypes.c_ubyte*3),('arch',ctypes.c_uint32),('ip',ctypes.c_uint64),('sp',ctypes.c_uint64),('data',ctypes.c_ubyte*64)]
def trace(request,pid,address=0,data=0):
    ctypes.set_errno(0);value=libc.ptrace(ctypes.c_uint(request),ctypes.c_int(pid),ctypes.c_void_p(address),data if not isinstance(data,int) else ctypes.c_void_p(data))
    if value==-1 and ctypes.get_errno():raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))
    return value

def syscall(pid):
    info=SysInfo();size=trace(INFO,pid,ctypes.sizeof(info),ctypes.byref(info));assert size>=24
    profile=dict(bindings.policy(info.arch));profile['exit']=profile['exits']
    if info.op==1:
        values=struct.unpack_from('=Q6Q',bytes(info.data));return dict(op='entry',nr=values[0],args=list(values[1:]),arch=info.arch),profile
    if info.op==2:return dict(op='exit',result=struct.unpack_from('=q',bytes(info.data))[0],isError=bool(info.data[8]),arch=info.arch),profile
    raise ValueError('unexpected syscall-info operation')

def cstring(pid,address):
    data=bytearray();word=ctypes.sizeof(ctypes.c_long)
    while len(data)<4096:
        value=trace(PEEKDATA,pid,address+len(data));chunk=int(value).to_bytes(word,'little',signed=True)
        if b'\0' in chunk:return (data+chunk.split(b'\0',1)[0]).decode('utf-8','strict')
        data.extend(chunk)
    raise ValueError('tracee path bound')

class RegisterVector(ctypes.Structure):
    _fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]
def deny_io_uring_setup(pid,arch,nr):
    """Change only the syscall number at its held entry stop; never resume."""
    regset,size,offset,width=bindings.denied_io_uring_register_layout(arch)
    assert nr==425,'only reviewed setup denial supported'
    def read():
        buffer=ctypes.create_string_buffer(size);vector=RegisterVector(ctypes.cast(buffer,ctypes.c_void_p),size)
        trace(0x4204,pid,regset,ctypes.byref(vector))
        assert vector.length==size,'kernel returned a different register layout'
        return bytes(buffer.raw)
    before=read();after=before[:offset]+b'\xff'*width+before[offset+width:]
    bindings.verify_denied_io_uring_registers(arch,nr,before,after)
    buffer=ctypes.create_string_buffer(after,size);vector=RegisterVector(ctypes.cast(buffer,ctypes.c_void_p),size)
    trace(0x4205,pid,regset,ctypes.byref(vector))
    actual=read();description=bindings.verify_denied_io_uring_registers(arch,nr,before,actual)
    return dict(**description,beforeRegistersHex=before.hex(),afterRegistersHex=actual.hex())
