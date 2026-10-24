"""Bounded interpreter classification over caller-held actual ELF originals.

No source/ABI capability is issued. Static means the complete actual program
header table contains no PT_INTERP, not that a caller claimed a static binary.
"""
import struct


def inspect_elf_loader(read_range, size, check):
    def need(ok, message):
        if not ok:
            raise ValueError('Service ABI ELF: ' + message)

    need(type(size) is int and 64 <= size <= 2**53-1, 'bounded file size')
    need(callable(read_range) and callable(check), 'actual range reader and parent check')

    def read(offset, length):
        need(type(offset) is int and type(length) is int and 0 <= offset <= size
             and 0 < length <= 65536 and length <= size-offset, 'bounded complete range')
        check()
        raw = read_range(offset, length)
        check()
        need(isinstance(raw, bytes) and len(raw) == length, 'exact original range')
        return raw

    header = read(0, 64)
    need(header[:7] == b'\x7fELF\x02\x01\x01', 'ELF64 little endian version one')
    kind, machine, version = struct.unpack_from('<HHI', header, 16)
    need(kind in (2, 3) and machine in (62, 183) and version == 1, 'executable ELF target')
    phoff = struct.unpack_from('<Q', header, 32)[0]
    ehsize, phsize, phnum = struct.unpack_from('<HHH', header, 52)
    need(ehsize == 64 and phsize == 56 and 1 <= phnum <= 4096, 'ordinary complete program table')
    need(64 <= phoff <= size and phnum*56 <= size-phoff, 'program table inside original')
    interpreter = None
    for index in range(phnum):
        entry = read(phoff+index*56, 56)
        segment, _flags, offset, _vaddr, _paddr, filesz, _memsz, _align = struct.unpack('<IIQQQQQQ', entry)
        need(offset <= size and filesz <= size-offset, 'program segment inside original')
        if segment != 3:
            continue
        need(interpreter is None and 2 <= filesz <= 4096, 'one bounded PT_INTERP')
        raw = read(offset, filesz)
        need(raw[-1:] == b'\0' and b'\0' not in raw[:-1], 'single terminated interpreter')
        interpreter = raw[:-1].decode('utf-8', errors='strict')
        need(interpreter.startswith('/') and all(part and part not in ('.', '..') for part in interpreter.split('/')[1:])
             and not any(ord(c) < 32 or ord(c) == 127 for c in interpreter) and '\\' not in interpreter,
             'canonical absolute interpreter')
    check()
    return {'kind': 'static', 'machine': machine} if interpreter is None else {
        'kind': 'dynamic', 'machine': machine, 'interpreter': interpreter}
