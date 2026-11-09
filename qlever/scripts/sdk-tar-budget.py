"""Exact stdlib PAX tar encoding budget, including final record padding."""
import tarfile

SHARD_LIMIT = 512 * 1024**2

def member_bytes(info):
    header = info.tobuf(format=tarfile.PAX_FORMAT, encoding='utf-8', errors='surrogateescape')
    return len(header) + ((info.size + 511) // 512 * 512 if info.isreg() else 0)

def archive_bytes(members):
    size = members + 2 * tarfile.BLOCKSIZE
    return ((size + tarfile.RECORDSIZE - 1) // tarfile.RECORDSIZE) * tarfile.RECORDSIZE

def require_fit(members, limit=SHARD_LIMIT):
    if archive_bytes(members) > limit:
        raise ValueError('SDK encoded tar exceeds shard byte budget')
