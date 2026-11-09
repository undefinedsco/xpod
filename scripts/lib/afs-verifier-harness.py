"""One fresh verifier worktree and controlled normal dependency installation.

No historical workspace tree is adopted. Process originals are produced by the
same owning consumer runner; this module never issues a trusted-tool capability.
"""
import json
from pathlib import Path
import shutil
import subprocess

POSTINSTALL = 'bun scripts/patch-jose.js && bun scripts/patch-inrupt-authn-refresh.js && bun scripts/patch-inrupt-authn-transport.js && bun scripts/patch-inrupt-authn-operation-cleanup.js'


def require(value, reason):
    if not value:
        raise ValueError('AFS fresh verifier: ' + reason)


class VerifierHarness:
    def __init__(self, runner):
        self.runner = runner
        self.recipe_refs = []

    def source_state(self):
        def git(*args):
            result = subprocess.run([str(self.git), '-C', str(self.workspace), *args], env=self.environment,
                                    capture_output=True, timeout=self.runner.budget.BUDGET['sourceObservationCommandSeconds'], check=True)
            require(len(result.stdout) <= 4 * 1024**2 and len(result.stderr) <= 65536, 'Git observation byte bound')
            return result.stdout.decode().strip()
        return dict(sha=git('rev-parse', 'HEAD'), status=git('status', '--porcelain', '--untracked-files=no'))

    def reference(self, file):
        return dict(path=file.relative_to(self.runner.output).as_posix(), bytes=file.stat().st_size,
                    sha256=self.runner.tool_originals.materials.digest(file))

    def write(self, name, value):
        file = self.directory / name
        with file.open('x') as stream:
            json.dump(value, stream, separators=(',', ':'))
        require(file.stat().st_size <= self.runner.tool_originals.LIMITS['metadataBytes'], 'recipe metadata bound')
        return self.reference(file)

    def preserve_inputs(self):
        package = json.loads(self.runner.small_original(self.workspace / 'package.json'))
        require(package.get('scripts', {}).get('postinstall') == POSTINSTALL, 'unreviewed repository postinstall recipe')
        names = ['package.json', 'bun.lock', 'scripts/check-dependency-state.ts',
                 'packages/xpod-cli/scripts/build-tools-package.ts', 'packages/xpod-client/scripts/build.ts']
        names += [part.split(' ', 1)[1] for part in POSTINSTALL.split(' && ')]
        names += list(package.get('patchedDependencies', {}).values())
        if (self.workspace / 'bunfig.toml').exists():
            names.append('bunfig.toml')
        refs = []
        for name in sorted(set(names)):
            require(self.runner.tool_originals.materials.safe(name) and not self.runner.tool_originals.materials.sensitive(name), 'unsafe recipe source path')
            file = self.workspace / name
            data = self.runner.small_original(file)
            destination = self.directory / 'inputs' / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with destination.open('xb') as stream:
                stream.write(data)
            refs.append(dict(sourcePath=name, original=self.reference(destination)))
        return refs

    def record(self, label):
        rows = [row for row in self.runner.records if row['label'] == label]
        require(len(rows) == 1, 'unique actual command observation required')
        row = rows[0]
        require(row['status'] == 'passed' and row['returncode'] == 0 and row['waitStatus'] == 'known'
                and row['rawHandlesClosed'] and row['rawClosedBeforeHash'] and row['ownedGroupAbsent'] and len(row['raw']) == 2,
                'actual verifier command did not close')
        return self.write(label + '.json', row)

    def prepare(self, root):
        r = self.runner
        self.workspace = root / 'verifier-harness'
        require(not self.workspace.exists() and not self.workspace.is_symlink(), 'fresh owned worktree path required')
        git = shutil.which('git', path='/usr/bin:/bin:/usr/sbin:/sbin')
        require(git is not None, 'fixed Git executable required')
        self.git = Path(git).resolve(strict=True)
        home, cache = root / 'verifier-home', root / 'verifier-cache'
        home.mkdir(mode=0o700); cache.mkdir(mode=0o700)
        self.environment = dict(HOME=str(home), TMPDIR=str(root), LANG='en_US.UTF-8',
                                PATH=str(Path(r.plan['node']).parent) + ':' + str(Path(r.plan['bun']).parent) + ':/usr/bin:/bin:/usr/sbin:/sbin')
        minimum = r.budget.projection()['freshHarnessLiveBytes'] + r.tool_originals.LIMITS['sourceMaterialBytes']
        require(r.plan['budget']['estimatedPeakBytes'] >= minimum, 'plan lacks fresh install/cache plus immutable snapshot allocation bound')
        (r.output / 'verifier-tools').mkdir(mode=0o700)
        self.directory = r.output / 'verifier-tools/install'
        self.directory.mkdir(mode=0o700)
        # This is the complete reviewed process recipe; callbacks cannot choose commands.
        commands = [
            ('checkout', [str(self.git), '-c', 'core.hooksPath=/dev/null', '-C', r.plan['checkout'], 'worktree', 'add', '--detach', str(self.workspace), r.plan['sourceSha']], root),
            ('install', [r.plan['bun'], 'install', '--frozen-lockfile', '--no-cache', '--registry', 'https://registry.npmjs.org/', '--backend=copyfile', '--linker=hoisted', '--cache-dir=' + str(cache)], self.workspace),
            ('build-tools', [r.plan['bun'], 'run', '--filter', '@undefineds.co/xpod-cli', 'build:tools'], self.workspace),
            ('client', [r.plan['bun'], 'run', '--filter', '@undefineds.co/xpod-client', 'build'], self.workspace),
            ('patch-check', [r.plan['bun'], 'scripts/check-dependency-state.ts', '--runtime-only'], self.workspace),
        ]
        for name, command, cwd in commands:
            r.command('verifier-harness-' + name, command, self.environment, cwd)
            self.recipe_refs.append(self.record('verifier-harness-' + name))
            if name == 'checkout':
                self.before = self.source_state()
                require(self.before == dict(sha=r.plan['sourceSha'], status='') and not (self.workspace / 'node_modules').exists(), 'clean exact Git source and absent installed tree required')
                self.input_refs = self.preserve_inputs()
        self.after = self.source_state()
        require(self.after == self.before, 'immutable verifier source changed during installation/build')
        r.checked['roots'].append(self.workspace)
        r.verifier_harness = self.workspace
        self.recipe_refs.append(self.write('prepared.json', dict(schemaVersion=1, kind='controlled-frozen-afs-verifier-install', sourceSha=r.plan['sourceSha'],
            workspace=str(self.workspace), sourceBefore=self.before, sourceAfter=self.after, inputs=self.input_refs, commands=self.recipe_refs.copy(),
            registry='https://registry.npmjs.org/', postinstall=POSTINSTALL, scope='Actual fresh frozen install/build/patch originals; authority requires independent immutable source/lock/runtime validation.')))
        r.result['verifierHarness'] = dict(workspace=str(self.workspace), sourceSha=r.plan['sourceSha'], prepared=self.recipe_refs[-1])
        r.save()

    def finish(self):
        r = self.runner
        require(self.source_state() == self.before, 'verifier source changed after mounted profiles')
        r.command('verifier-harness-remove', [str(self.git), '-c', 'core.hooksPath=/dev/null', '-C', r.plan['checkout'], 'worktree', 'remove', '--force', str(self.workspace)], self.environment, r.owned)
        self.recipe_refs.append(self.record('verifier-harness-remove'))
        require(not self.workspace.exists(), 'actual owned verifier worktree remains')
        self.recipe_refs.append(self.write('complete.json', dict(schemaVersion=1, kind='controlled-frozen-afs-verifier-install-complete', sourceSha=r.plan['sourceSha'],
             workspace=str(self.workspace), sourceBefore=self.before, sourceAfter=self.after, prepared=r.result['verifierHarness']['prepared'], commands=[ref for ref in self.recipe_refs if Path(ref['path']).name.startswith('verifier-harness-')])))
        r.result['verifierHarness']['completed'] = self.recipe_refs[-1]
        r.tool_capture.install_originals = self.recipe_refs + [row['original'] for row in self.input_refs]
        r.tool_capture.pending = [value for value in r.tool_capture.pending if value != 'historical harness frozen-install supervised originals not observed by this consumer']
        r.result['verifierToolOriginals'] = r.tool_capture.write_master()
        r.save()
