#!/usr/bin/env python3
"""Execute the sole recorded command from the inherited, held cwd descriptor.

No budget, subprocess, timer, path fallback, or source qualification is created.
The pack parent supervises this process, which is replaced by the real command.
"""
import json
import os
import stat
import sys


def run(argv):
    if len(argv) < 4:
        raise ValueError('held command cwd and actual argv required')
    expected = json.loads(argv[1])
    canonical = argv[2]
    if not isinstance(expected, list) or len(expected) != 7 or not all(isinstance(x, str) for x in expected):
        raise ValueError('complete held directory identity required')
    value = os.fstat(3)
    actual = [str(value.st_dev), str(value.st_ino), str(value.st_mode), str(value.st_size), str(value.st_mtime_ns), str(value.st_ctime_ns), str(value.st_nlink)]
    if not stat.S_ISDIR(value.st_mode) or actual != expected:
        raise ValueError('actual inherited cwd differs')
    os.fchdir(3)
    if os.getcwd() != canonical:
        raise ValueError('actual inherited cwd path differs')
    os.close(3)
    os.execvp(argv[3], argv[3:])


if __name__ == '__main__':
    run(sys.argv)
