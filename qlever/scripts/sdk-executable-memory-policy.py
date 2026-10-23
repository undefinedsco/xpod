"""Narrow file-backed execution policy; no host-writer or source authority.

Executable pages may originate in kernel exec or a leased file RX mmap only.
All explicit protection-to-executable transitions and remaps are refused,
including harmless-looking transitions; this scope deliberately excludes JITs.
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
