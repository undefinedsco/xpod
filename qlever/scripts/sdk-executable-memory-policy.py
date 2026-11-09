"""Narrow file-backed execution policy; no host-writer or source authority.

Executable pages may originate in kernel exec or a leased file RX mmap only.
Explicit protection-to-executable transitions and remaps are refused.
Declared ARM64 BTI hardening requires separate held, previously RX VMA proof; this scope deliberately excludes JITs.
Linux AIO and io_uring submission are refused: their asynchronous writes do not
pass through the synchronous per-descriptor write entry evidence contract.
"""
MODEL='file-exec-no-transition-v1'
ABI={
 0xc000003e:dict(mmap=9,protect={10,329},remap=25,remap_pages=216,forbidden={101,311,135,30,323,435,206,209,425,426,427},writes={1:0,18:0,20:0,296:0,328:0,40:0,275:2,278:0,326:2}),
 0xc00000b7:dict(mmap=222,protect={226,288},remap=216,remap_pages=234,forbidden={117,271,92,196,282,435,0,2,425,426,427},writes={64:0,68:0,66:0,70:0,287:0,71:0,76:2,75:0,285:2})
}
def decision(arch,nr,args):
 if arch not in ABI:raise ValueError('unsupported executable-memory ABI')
 p=ABI[arch]
 if nr in p['forbidden']:return 'external-memory-writer-or-implicit-execution-mode'
 if nr in {p['remap'],p['remap_pages']}:return 'memory-remap-outside-fixed-executable-mapping-scope'
 if nr in p['protect'] and args[2]&4:return 'explicit-protection-to-executable-transition'
 if nr==p['mmap'] and args[2]&4:
  if args[2]&2:return 'writable-executable-mapping'
  if args[3]&0x20:return 'anonymous-executable-mapping'
 return None

def write_descriptor(arch,nr,args):
 slot=ABI[arch]['writes'].get(nr)
 return None if slot is None else args[slot]

# ---------------------------------------------------------------------------
# Bounded private-anonymous mremap candidate
#
# `decision()` above stays argument-blind and UNCHANGED: every remap is still
# refused by default. This predicate is consulted only by the observer, and only
# after it has proved the whole source range under a real all-stop. It is a
# pure shape test on the six syscall arguments; it grants nothing on its own.
#
# Allowed shape is deliberately the narrowest that covers ordinary allocator
# growth: mremap on the two supported arches with flags 0 or MREMAP_MAYMOVE.
# ---------------------------------------------------------------------------
# Separate declared capability model: this is a real raw-record capability, not
# the `file-exec-no-transition-v1` diagnostic, so the verifier can accept it only
# when every exclusive/coverage obligation is present in the actual raw stream.
REMAP_MODEL='private-anonymous-nonexec-mremap-v1'
MREMAP_MAYMOVE=1
MREMAP_FIXED=2
MREMAP_DONTUNMAP=4
MREMAP_ALLOWED_FLAGS=frozenset([0,MREMAP_MAYMOVE])
MREMAP_REASON_FIXED='memory-remap-fixed-destination-refused'
MREMAP_REASON_DONTUNMAP='memory-remap-dontunmap-refused'
MREMAP_REASON_FLAGS='memory-remap-unknown-flag-refused'
MREMAP_REASON_SIZES='memory-remap-size-refused'
MREMAP_REASON_ALIGN='memory-remap-address-alignment-refused'
MREMAP_REASON_BOUND='memory-remap-size-bound-refused'


def _exact_int(value):
 return type(value) is int


def remap_shape(arch,nr,args,maximum=None):
 """Classify one remap syscall's ARGUMENT SHAPE only. Never grants permission.

 Returns (candidate, reason, geometry) where geometry is a dict of already
 validated integers when candidate is True. Any doubt returns candidate=False
 with a specific closed-set reason; the caller must then refuse as it does now.
 """
 if arch not in ABI:return False,'unsupported executable-memory ABI',None
 p=ABI[arch]
 if not _exact_int(nr) or not _exact_int(arch):return False,MREMAP_REASON_FLAGS,None
 if nr==p['remap_pages']:return False,'memory-remap-file-pages-refused',None
 if nr!=p['remap']:return False,MREMAP_REASON_FLAGS,None
 if not isinstance(args,(list,tuple)) or len(args)<6:return False,MREMAP_REASON_SIZES,None
 if not all(_exact_int(value) and 0<=value<1<<64 for value in args[:6]):return False,MREMAP_REASON_SIZES,None
 old_address,old_size,new_size,flags,new_address,_=args[:6]
 if flags&MREMAP_FIXED:return False,MREMAP_REASON_FIXED,None
 if flags&MREMAP_DONTUNMAP:return False,MREMAP_REASON_DONTUNMAP,None
 if flags not in MREMAP_ALLOWED_FLAGS:return False,MREMAP_REASON_FLAGS,None
 if old_size==0 or new_size==0:return False,MREMAP_REASON_SIZES,None
 if old_address==0 or old_address%4096:return False,MREMAP_REASON_ALIGN,None
 if old_address+old_size>1<<64 or new_size>1<<64:return False,MREMAP_REASON_BOUND,None
 if maximum is not None:
  if not _exact_int(maximum) or maximum<0:return False,MREMAP_REASON_BOUND,None
  if old_size>maximum or new_size>maximum:return False,MREMAP_REASON_BOUND,None
 # MREMAP_FIXED already refused, so new_address cannot select a destination.
 return True,None,dict(oldAddress=old_address,oldSize=old_size,newSize=new_size,
                       flags=flags,mayMove=bool(flags&MREMAP_MAYMOVE),newAddress=new_address)


def remap_range(old_address,old_size,page=4096):
 """Page-rounded closed source interval, or None when it cannot be formed."""
 if not(_exact_int(old_address) and _exact_int(old_size) and _exact_int(page)):return None
 if page<=0 or old_size<=0 or old_address<0:return None
 low=old_address-(old_address%page)
 high=old_address+old_size
 if high<=old_address or high>1<<64:return None
 high=high+((page-high%page)%page)
 if high>1<<64:return None
 return low,high


def mapping_is_private_anonymous_nonexec(row):
 """True only for a plain private anonymous non-executable data VMA.

 Conservative on purpose: shared ('s'), executable ('x'), file-backed (ino != 0
 or a non-empty path) and bracketed special mappings are all rejected. A caller
 that needs one of those must extend this predicate with separate proof.
 """
 if not isinstance(row,dict):return False
 permissions=row.get('permissions')
 if not isinstance(permissions,str) or len(permissions)!=4:return False
 if permissions[0]!='r' or permissions[1]!='w':return False
 if permissions[2]!='-' or permissions[3]!='p':return False
 path=row.get('path')
 if path:return False
 return row.get('inode')==0


def cover_nonexec_range(mappings,low,high,page=4096):
 """Prove [low,high) is fully covered by contiguous private-anon non-exec VMAs.

 Returns (ok, reason, coveredBytes, executableBytes). Any hole, any executable
 page, any non-private/non-anonymous/non-data VMA or an unaligned boundary fails
 closed. Never treats a single sample line as permission: every overlapping VMA
 must be consumed in address order until the interval is exactly covered.
 """
 if not(_exact_int(low) and _exact_int(high) and _exact_int(page)):return False,'memory-remap-range-shape-refused',0,0
 if page<=0 or low<0 or high<=low or low%page or high%page:return False,'memory-remap-range-shape-refused',0,0
 if not isinstance(mappings,(list,tuple)):return False,'memory-remap-maps-unavailable',0,0
 cursor=low;covered=0;executable=0
 rows=sorted((row for row in mappings if isinstance(row,dict) and 'startHex' in row and 'endHex' in row),
             key=lambda row:int(row['startHex'],16))
 for row in rows:
  start=int(row['startHex'],16);stop=int(row['endHex'],16)
  if stop<=cursor or start>=high:
   continue
  if start>cursor:return False,'memory-remap-range-hole-refused',covered,executable
  if not mapping_is_private_anonymous_nonexec(row):
   permissions=row.get('permissions') or ''
   if 'x' in permissions:executable+=max(0,min(stop,high)-max(start,cursor))
   return False,'memory-remap-vma-not-private-anonymous-nonexec-refused',covered,executable
  covered+=max(0,min(stop,high)-cursor);cursor=min(stop,high)
  if cursor>=high:return True,None,covered,executable
 return False,'memory-remap-range-not-fully-covered',covered,executable

def memory_fd(path):
 import re
 return isinstance(path,str) and re.fullmatch(r'/proc/(?:self|thread-self|[0-9]+)/(?:task/[0-9]+/)?mem',path) is not None

def validate_mappings(mappings):
 for row in mappings:
  if 'x' not in row['permissions']:continue
  if 'w' in row['permissions']:raise ValueError('writable executable VMA')
  if not row['inode'] or not row['path'].startswith('/'):
   if row['path'] not in ['[vdso]','[vsyscall]']:raise ValueError('anonymous executable VMA outside kernel special mappings')

CLONE3_FIELDS=('flags','pidfd','child_tid','parent_tid','exit_signal','stack','stack_size','tls','set_tid','set_tid_size','cgroup')
CLONE3_SIZES=(64,80,88)
CLONE_VM=0x100
CLONE_VFORK=0x4000
CLONE_CLEAR_SIGHAND=0x100000000
CLONE_VFORK_FLAGS=CLONE_VM|CLONE_VFORK|CLONE_CLEAR_SIGHAND
# Actual pthread_create thread mode: shared VM/FS/FILES/SIGHAND, thread group,
# SysV semaphore undo inheritance and the TLS/TID handshakes glibc supplies.
CLONE_FS=0x200
CLONE_FILES=0x400
CLONE_SIGHAND=0x800
CLONE_THREAD=0x10000
CLONE_SYSVSEM=0x40000
CLONE_SETTLS=0x80000
CLONE_PARENT_SETTID=0x100000
CLONE_CHILD_CLEARTID=0x200000
CLONE_PIDFD=0x1000
CLONE3_THREAD_FLAGS=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM|CLONE_SETTLS|CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID
# Fields a thread-mode struct must populate; pidfd stays forbidden for threads.
CLONE3_THREAD_REQUIRED_FIELDS=('child_tid','parent_tid','tls')
CLONE3_ZERO_FIELDS=('pidfd','child_tid','parent_tid','tls','set_tid','set_tid_size','cgroup')

# Single shared clone-shape policy used by BOTH the legacy clone(2) syscall branch
# and the clone3 struct branch, with an explicit syscall-shape distinction so the
# two paths cannot disagree about semantics while keeping clone3's struct-specific
# field strictness.
CLONE_PARENT=0x8000
CLONE_CHILD_SETTID=0x1000000
CLONE3_LEGACY_THREAD_REQUIRED=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD
# Exact preexisting HEAD030 legacy clone(2) known mask, identical to the
# bindings.inspect_shared_clone_flags contract: fork/vfork/thread ownership flags
# plus CLONE_PARENT, CLONE_CHILD_SETTID and CLONE_CLEAR_SIGHAND.
LEGACY_CLONE_KNOWN=(0xff|CLONE_VM|CLONE_VFORK|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|
                    CLONE_THREAD|CLONE_PARENT|CLONE_SYSVSEM|CLONE_SETTLS|
                    CLONE_PARENT_SETTID|CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|
                    CLONE_CLEAR_SIGHAND)
# clone3 keeps its own tighter masks: the struct branch never inherits the wider
# legacy fork word. (The non-thread clone3 mask is CLONE_VFORK_FLAGS.)
CLONE3_THREAD_ALLOWED=CLONE3_THREAD_FLAGS


def classify_clone(flags, *, syscall='legacy'):
    """Classify an actual clone(2)/clone3 flag word; raises on unknown/mixed shape.

    syscall='legacy' accepts the exact HEAD030 clone(2) known mask (fork/vfork/
    thread ownership flags incl. CLONE_PARENT, CLONE_CHILD_SETTID,
    CLONE_CLEAR_SIGHAND); clone3 thread/non-thread masks stay as strict as before.
    Returns a frozen-shape dict describing the only accepted shapes:
      thread : CLONE_THREAD sharing VM/FS/FILES/SIGHAND
      vfork  : CLONE_VM|CLONE_VFORK shared memory with a held parent
      fork   : independent address space
    """
    if type(flags) is not int or flags < 0:
        raise ValueError('clone flags must be a non-negative integer')
    if syscall=='legacy':allowed=LEGACY_CLONE_KNOWN
    elif syscall=='clone3':allowed=CLONE_VFORK_FLAGS
    elif syscall=='clone3-thread':allowed=CLONE3_THREAD_ALLOWED
    else:raise ValueError('unknown clone syscall shape')
    thread = bool(flags & CLONE_THREAD)
    # Thread mode must not carry any exit-signal byte.
    if thread and flags & 0xff:
        raise ValueError('clone thread mode must not carry an exit signal')
    if flags & ~allowed:
        raise ValueError('unknown clone flags refused' if syscall=='legacy' else 'unsupported clone3 flags')
    shared_vm = bool(flags & CLONE_VM)
    vfork = bool(flags & CLONE_VFORK)
    if thread:
        if vfork:
            raise ValueError('clone thread mode may not request vfork')
        if flags & CLONE3_LEGACY_THREAD_REQUIRED != CLONE3_LEGACY_THREAD_REQUIRED:
            raise ValueError('clone thread mode requires shared VM/FS/FILES/SIGHAND')
        return dict(thread=True,vfork=False,sharedVm=True,sharedFdTable=True,
                    sharedSignalHandlers=True,exitSignal=0)
    if vfork:
        if not shared_vm:
            raise ValueError('CLONE_VFORK requires CLONE_VM')
        if flags & CLONE_FILES:
            raise ValueError('vfork may not share the FD table')
        return dict(thread=False,vfork=True,sharedVm=True,sharedFdTable=False,
                    sharedSignalHandlers=bool(flags & CLONE_SIGHAND),exitSignal=None)
    if flags & CLONE_FILES:
        raise ValueError('shared FD table requires clone thread mode')
    if shared_vm:
        raise ValueError('CLONE_VM requires CLONE_VFORK or CLONE_THREAD')
    return dict(thread=False,vfork=False,sharedVm=False,sharedFdTable=False,
                sharedSignalHandlers=bool(flags & CLONE_SIGHAND),exitSignal=None)


def parse_clone3_original(data,size):
 if type(data) is not bytes:raise ValueError('clone3 args must be actual bytes')
 if type(size) is not int or size not in CLONE3_SIZES:raise ValueError('unsupported clone3 args size')
 if len(data)!=size:raise ValueError('clone3 args length does not match size')
 values={name:0 for name in CLONE3_FIELDS}
 for index,name in enumerate(CLONE3_FIELDS):
  if index*8+8<=size:values[name]=int.from_bytes(data[index*8:index*8+8],'little')
 flags=values['flags']
 thread=bool(flags&CLONE_THREAD)
 if thread:
  # Ordinary pthread thread creation: thread group plus shared address space,
  # FD table, signal handlers and semaphore undo; exit_signal is zero and the
  # TLS/TID words are real userspace pointers supplied by the library.
  shape=classify_clone(flags,syscall='clone3-thread')
  if not shape['thread']:raise ValueError('clone3 thread mode requires CLONE_THREAD')
  if values['exit_signal']!=0:raise ValueError('clone3 thread exit signal must be zero')
  # set_tid/cgroup are kernel-extension words: no thread may request them.
  for name in ('set_tid','set_tid_size','cgroup'):
   if values[name]:raise ValueError('unsupported clone3 thread field')
  # pidfd is only meaningful with CLONE_PIDFD (not set here); without it the
  # word is unread by the kernel and must not be asserted zero.
  if flags&CLONE_PIDFD:
   if not values['pidfd']:raise ValueError('clone3 thread pidfd requires a descriptor value')
  elif values['pidfd'] and not values['child_tid']:raise ValueError('clone3 thread pidfd word without CLONE_PIDFD')
  for name in CLONE3_THREAD_REQUIRED_FIELDS:
   if not values[name]:raise ValueError('clone3 thread field must be a real non-zero value')
  stack=values['stack'];stack_size=values['stack_size']
  if not stack or not stack_size:raise ValueError('CLONE_VM requires stack and stack size')
  if stack+stack_size>=2**64:raise ValueError('clone3 stack range overflows')
  return dict(flags=flags,exitSignal=values['exit_signal'],stack=stack,stackSize=stack_size,size=size,thread=True,tgidShared=True,sharedFdTable=True,sharedSignalHandlers=True)
 shape=classify_clone(flags,syscall='clone3')
 has_vm=shape['sharedVm']
 has_vfork=shape['vfork']
 if has_vm!=has_vfork:raise ValueError('CLONE_VM and CLONE_VFORK must be used together')
 if values['exit_signal']!=17:raise ValueError('clone3 exit signal must be SIGCHLD')
 if any(values[name] for name in CLONE3_ZERO_FIELDS):raise ValueError('unsupported nonzero clone3 field')
 stack=values['stack']
 stack_size=values['stack_size']
 if has_vm:
  if not stack or not stack_size:raise ValueError('CLONE_VM requires stack and stack size')
  if stack+stack_size>=2**64:raise ValueError('clone3 stack range overflows')
 elif stack or stack_size:raise ValueError('non-CLONE_VM clone3 requires zero stack')
 return dict(flags=flags,exitSignal=values['exit_signal'],stack=stack,stackSize=stack_size,size=size)

BTI_ARCH=0xc00000b7
BTI_NR=226
BTI_PROT_RX_BTI=0x15
BTI_PAGE_SIZES=(4096,16384,65536)
BTI_PERMISSIONS=('r-xp','r-xs')
BTI_LIMIT=1<<64

def _bti_hex(field,value):
 if type(value) is not str:raise ValueError('mapping '+field+' must be canonical hexadecimal')
 try:number=int(value,16)
 except ValueError:raise ValueError('mapping '+field+' must be canonical hexadecimal')
 if format(number,'x')!=value:raise ValueError('mapping '+field+' must be canonical hexadecimal')
 if not 0<=number<=BTI_LIMIT:raise ValueError('mapping '+field+' exceeds the address space')
 return number

def _bti_range(row,page_size):
 if not isinstance(row,dict):raise ValueError('mapping row must be a dictionary')
 start=_bti_hex('startHex',row.get('startHex'))
 end=_bti_hex('endHex',row.get('endHex'))
 if end<=start:raise ValueError('mapping range must be nonempty')
 if start%page_size or end%page_size:raise ValueError('mapping boundaries must be page aligned')
 return start,end

def _bti_file_exec_mapping(row):
 if row.get('permissions') not in BTI_PERMISSIONS:raise ValueError('mapping permissions must be exact file read-execute')
 inode=row.get('inode')
 if type(inode) is not int or inode<=0:raise ValueError('mapping inode must be a positive integer')
 path=row.get('path')
 if type(path) is not str or not path.startswith('/'):raise ValueError('mapping path must be an absolute file path')

def bti_mappings(arch,nr,args,mappings,page_size):
 if type(arch) is not int or arch!=BTI_ARCH:raise ValueError('unsupported executable-memory ABI')
 if type(nr) is not int or nr!=BTI_NR:raise ValueError('BTI mapping requires the fixed mapping syscall number')
 if not isinstance(args,(list,tuple)) or len(args)!=6:raise ValueError('BTI mapping requires exactly six syscall arguments')
 if any(type(value) is not int or not 0<=value<BTI_LIMIT for value in args):raise ValueError('BTI mapping arguments must be uint64 integers')
 if args[2]!=BTI_PROT_RX_BTI:raise ValueError('BTI mapping requires read-execute-bti protection')
 if type(page_size) is not int or page_size not in BTI_PAGE_SIZES:raise ValueError('unsupported page size')
 start,length=args[0],args[1]
 if start<=0 or start%page_size:raise ValueError('BTI mapping start must be positive and page aligned')
 if length<=0:raise ValueError('BTI mapping length must be positive')
 if length>BTI_LIMIT-start:raise ValueError('BTI mapping requested end overflows the address space')
 end=start+length
 rounded_end=(end+page_size-1)//page_size*page_size
 if rounded_end>BTI_LIMIT:raise ValueError('BTI mapping rounded end overflows the address space')
 try:rows=list(mappings)
 except TypeError:raise ValueError('mappings must be iterable dictionaries')
 candidates=[]
 for row in rows:
  row_start,row_end=_bti_range(row,page_size)
  if row_end<=start or row_start>=rounded_end:continue
  if row_start<start or row_end>rounded_end:raise ValueError('mapping pages outside requested coverage')
  _bti_file_exec_mapping(row)
  candidates.append((row_start,row_end,row))
 candidates.sort(key=lambda item:(item[0],item[1]))
 selected=[];cursor=start
 for row_start,row_end,row in candidates:
  if row_start!=cursor:raise ValueError('mapping coverage gap or overlap')
  selected.append(row);cursor=row_end
 if cursor!=rounded_end:raise ValueError('mapping coverage gap or overlap')
 return selected


def bti_candidate(arch,nr,args):
 return arch==BTI_ARCH and nr==BTI_NR and len(args)==6 and args[2]==BTI_PROT_RX_BTI
