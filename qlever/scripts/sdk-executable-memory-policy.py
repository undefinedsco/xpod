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
CLONE3_SUPPORTED_FLAGS=CLONE_VM|CLONE_VFORK|CLONE_CLEAR_SIGHAND
CLONE3_ZERO_FIELDS=('pidfd','child_tid','parent_tid','tls','set_tid','set_tid_size','cgroup')

def parse_clone3_original(data,size):
 if type(data) is not bytes:raise ValueError('clone3 args must be actual bytes')
 if type(size) is not int or size not in CLONE3_SIZES:raise ValueError('unsupported clone3 args size')
 if len(data)!=size:raise ValueError('clone3 args length does not match size')
 values={name:0 for name in CLONE3_FIELDS}
 for index,name in enumerate(CLONE3_FIELDS):
  if index*8+8<=size:values[name]=int.from_bytes(data[index*8:index*8+8],'little')
 flags=values['flags']
 if flags&~CLONE3_SUPPORTED_FLAGS:raise ValueError('unsupported clone3 flags')
 has_vm=bool(flags&CLONE_VM)
 has_vfork=bool(flags&CLONE_VFORK)
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
