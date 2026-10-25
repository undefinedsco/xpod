"""Direct native command adapter; no interpreter or test tools in the image.

Ownership/security flags remain defined by the existing output-image helper.
This pure builder does not prove actual creation, waiting, cleanup or ABI.
"""
from pathlib import Path
import stat

RUNTIME = '/opt/xpod/qlever/bin/xpod_qlever_local_runtime'

def command(image_commands, role, image, name, nonce, *, cid=None, scratch=None):
    original = image_commands.output_image_command
    if role == 'execute':
        original('inspect', image, name, nonce, cid)
        return image_commands.outer.binding.local_docker(['docker', 'container', 'start', '--attach', '--interactive', cid])
    if role != 'create':
        return original(role, image, name, nonce, cid)
    base = original('create', image, name, nonce)
    if (not isinstance(scratch, Path) or not scratch.is_absolute() or
            scratch.resolve(strict=True) != scratch or not scratch.is_dir() or
            scratch.name != name + '-scratch' or ',' in str(scratch)):
        raise ValueError('canonical independently owned scratch directory required')
    database = scratch / 'abi.sqlite'
    if sorted(path.name for path in scratch.iterdir()) != ['abi.sqlite']:
        raise ValueError('only the fresh smoke database may be mounted')
    value = database.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or not 0 < value.st_size <= 8*1024**2:
        raise ValueError('bounded single-link smoke database original required')
    if base[-1] != image:
        raise ValueError('unchanged original image command required')
    return [*base[:-1], '--interactive', '--init', '--pids-limit', '64',
            '--memory', '512m', '--cpus', '1', '--mount',
            'type=bind,src=' + str(scratch) + ',dst=/scratch',
            '--entrypoint', RUNTIME, image, '--sqlite-path', '/scratch/abi.sqlite']
