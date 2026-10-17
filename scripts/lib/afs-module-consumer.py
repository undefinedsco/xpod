#!/usr/bin/env python3
"""Normal installed AFS consumer: same transport/ownership runner as API/CSS.

Default is validation only. --run retains the complete registered mounted
profile; unavailable kernel/tooling prerequisites fail, with no reduced smoke
profile. Native ZIPs never stand in for the normal AFS product archive.
"""
import argparse
import importlib.util
import json
import pathlib
import os
import stat
import shlex
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('afs_shared_consumer', HERE / 'module-consumer.py')
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)
require = lifecycle.require
BRIDGE = HERE / 'afs-module-consumer-bridge.ts'
WORKFLOW = '.github/workflows/agentfs-module-mounted-acceptance.yml'
LIMITS = json.loads((HERE / 'module-artifact-limits.json').read_text())

def bounded_json(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= LIMITS['metadataBytes'], 'AFS JSON original byte bound')
        parts, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, LIMITS['metadataBytes'] + 1 - size))
            if not chunk:
                break
            parts.append(chunk); size += len(chunk)
            require(size <= LIMITS['metadataBytes'], 'AFS JSON original byte bound')
        after = os.fstat(fd)
        require(size == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'AFS JSON original changed')
        return json.loads(b''.join(parts))
    finally:
        os.close(fd)


def target(module, value, bun, host=False):
    require(module == 'afs', 'fixed AFS target resolver required')
    args = [bun, str(BRIDGE), 'target', value] + (['--require-host'] if host else [])
    result = subprocess.run(args, text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, 'AFS canonical target/host rejected')
    row = json.loads(result.stdout)
    require(row.get('target') == value, 'AFS target authority differs')
    return row


def bind_projection(receipt, producer, declaration):
    context = producer['context']
    require(receipt.get('target') == context['target'] == declaration['target'] and receipt.get('version') == context['version'], 'AFS projection target/version differs')
    require(receipt.get('archive') == producer.get('archive'), 'AFS normal archive tuple differs')
    return dict(receipt, package=dict(name=declaration['name'], target=context['target'], version=context['version']))


def profile():
    return dict(id='afs', projectionKind='afs-product-input-projection', workflowPath=WORKFLOW, targetResolver=target,
                producerFlags=['published', 'releaseQualified', 'legalClearance', 'nativeAdmission'],
                projectionFlags=['actualCheckoutVerified', 'exactAttemptAdmitted', 'published', 'releaseQualified',
                                 'sourceAdmission', 'nativeAdmission', 'legalClearance', 'consumerValidated'],
                materials=set(), verifyMaterials=lambda rows: rows == {}, bindProjection=bind_projection,
                consumerInputRequired=False)


def validate(plan):
    require(lifecycle.consumer_transport(plan) in ('production-npm-registry', 'collected-product-archives'), 'AFS normal consumer rejects fixture transport')
    checked = lifecycle.validate_consumer_plan(plan, profile())
    preflight = lifecycle.reference(plan['afsPreflightDriver'])
    require(preflight.name == 'module-admission.mjs', 'actual producer bundled preflight driver required')
    require(all(not lifecycle.inside(preflight, root) for root in checked['roots']), 'AFS preflight tool must be outside denied sources')
    checked['preflightDriver'] = preflight
    return checked


class Runner(lifecycle.ModuleConsumerRunner):
    module_id = 'afs'
    driver_path = __file__
    target_resolver = staticmethod(target)
    additional_drivers = [BRIDGE, HERE.parent / 'agentfs-native-ci/mounted/platform-admission.ts',
                          HERE.parent / 'agentfs-native-ci/mounted/module-admission.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/nativeMountedPlatformMatrix.test.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/nativeOverlayScenario.test.ts',
                          HERE.parent.parent / 'tests/agentfs-pod/installedModuleMountedChain.test.ts']

    def verify_installed(self, runtime, root, package):
        require(package['xpodModule']['id'] == 'afs' and package['xpodModule']['entry'] == 'dist/entry.mjs', 'installed AFS entry declaration differs')
        require(bounded_json(root / 'package.json') == package, 'AFS installed manifest changed')
        kit = bounded_json(root / 'provenance/module-source-kit.json')
        native = bounded_json(root / 'provenance/native-reuse.json')
        require(kit.get('dirty') is False and kit.get('moduleSourceSHA') == self.plan['sourceSha']
                and native.get('moduleSourceDirty') is False and native.get('moduleSourceSHA') == self.plan['sourceSha'], 'installed AFS source receipt differs')
        require(native.get('helperSHA256') == lifecycle.digest(root / 'helper/agentfs-pod'), 'installed AFS native helper original differs')
        return dict(helperSha256=lifecycle.digest(root / 'helper/agentfs-pod'), entrySha256=lifecycle.digest(root / 'dist/entry.mjs'))

    def exercise_service(self, runtime, cli, env, cycle, data, package_root, installed_package):
        sandbox = cli[:-1]
        lifecycle.verify_registry_tools(cycle, self.plan['registryTools'])
        listing = json.loads((self.output / (runtime + '-list-afs.stdout.raw.log')).read_text())
        require(listing.get('ok') is True and isinstance(listing.get('data'), list), 'public CLI module discovery envelope invalid')
        rows = [row for row in listing['data'] if row.get('id') == 'afs']
        require(len(rows) == 1 and rows[0].get('installed', {}).get('version') == installed_package['version']
                and rows[0]['installed'].get('package') == installed_package['name'], 'public CLI did not discover exact installed AFS')
        self.command(runtime + '-afs-help', cli + ['afs', '--help'], env, cycle)
        helper = package_root / 'helper/agentfs-pod'
        self.command(runtime + '-afs-native-version', sandbox + [str(helper), '--version'], env, cycle)
        require((self.output / (runtime + '-afs-native-version.stdout.raw.log')).read_text().strip().startswith('agentfs-pod '), 'actual installed native smoke failed')
        # The trusted test orchestrator can read its own harness. Candidate CLI
        # processes enter the same source-denial sandbox via this fixed launcher.
        tools = cycle / 'runtime-bin'
        for name in ['rg', 'git']:
            executable = shutil.which(name)
            require(executable is not None, 'full mounted profile tool unavailable: ' + name)
            (tools / name).symlink_to(pathlib.Path(executable).resolve(strict=True))
        private_env = dict(env, SOLID_HOME=str(cycle / 'home/.solid'))
        launcher = cycle / 'afs-installed-cli'
        exports = ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in private_env.items())
        launcher.write_text('#!/bin/sh\nunset NODE_PATH NODE_OPTIONS BUN_OPTIONS\n' + exports
                            + 'exec ' + ' '.join(shlex.quote(arg) for arg in cli) + ' "$@"\n')
        launcher.chmod(0o700)
        evidence = self.output / (runtime + '-mounted')
        evidence.mkdir(mode=0o700)
        bound = lambda file: dict(path=str(file), sha256=lifecycle.digest(file))
        handoff = dict(schemaVersion=1, sourceSha=self.plan['sourceSha'], target=self.plan['target'], workspace=self.plan['checkout'],
                       evidence=str(evidence), home=str(cycle / 'home'), packageRoot=str(package_root), packageManifest=bound(package_root / 'package.json'),
                       storeRoot=str(cycle / 'home/.xpod/modules'), runtime=runtime,
                       archive=bound(self.checked['originals']['afs']), helper=bound(helper), entry=bound(package_root / 'dist/entry.mjs'),
                       launcher=bound(launcher), cliCore=bound(cycle / 'node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs'),
                       node=bound(pathlib.Path(self.plan['node'])), selectedRuntime=bound(pathlib.Path(self.plan[runtime])),
                       preflightDriver=bound(self.checked['preflightDriver']),
                       runtimes={name: bound(pathlib.Path(self.plan[name])) for name in ['node', 'bun']})
        input_file = cycle / 'afs-installed-handoff.json'
        input_file.write_text(json.dumps(handoff))
        # No source-denial wrapper around trusted Vitest/tooling. Every installed
        # CLI invocation in its authenticated mounted chain uses the launcher.
        try:
            self.command(runtime + '-afs-full-mounted-profile', [self.plan['bun'], str(BRIDGE), str(input_file), lifecycle.digest(input_file)], private_env, cycle)
        except BaseException:
            # The existing mounted harness owns detached test/helper groups and
            # kernel mounts. Outer bridge closure alone cannot prove them absent.
            self.groups_unknown = True
            raise
        observed = json.loads((self.output / (runtime + '-afs-full-mounted-profile.stdout.raw.log')).read_text().splitlines()[-1])
        require(observed.get('status') == 'complete-mounted-profile-verified' and observed.get('runtime') == runtime
                and observed.get('authenticatedRead') is True and observed.get('conditionalWriteback') is True
                and observed.get('cleanupVerified') is True, 'full installed AFS mounted profile did not pass')
        lifecycle.verify_registry_tools(cycle, self.plan['registryTools'])
        self.result['installedVerification'][runtime]['mountedProfile'] = observed
        self.save()
        lifecycle.inventory(package_root, json.loads((cycle / 'home/.xpod/modules/afs' / self.plan['target'] / 'current.json').read_text()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    plan = bounded_json(pathlib.Path(args.input))
    checked = validate(plan)
    if not args.run:
        print(json.dumps(dict(status='validated-dry-run', mutated=False, realConsumerValidated=False, releaseQualified=False)))
        return
    runner = Runner(plan, checked)
    runner.run()
    require(runner.result['status'] == 'passed', 'AFS normal consumer cleanup failed')
    print(json.dumps(runner.result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('AFS normal consumer: ' + str(error), file=sys.stderr)
        sys.exit(1)
