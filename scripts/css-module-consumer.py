#!/usr/bin/env python3
"""Pinned, private CSS public-CLI consumer. Default is read-only validation.

Input v1: sourceSha, checkout, sourceRoots[], cssReceipt/cliReceipt {path,sha256},
cssArchive/cliArchive/clientArchive {path,sha256,integrity}, node, bun,
output (new directory), temporaryParent (existing private directory),
budget {estimatedPeakBytes,remainingFloorBytes,cushionBytes}, timeoutSeconds.
No release qualification is inferred from this fixture-backed transport exercise.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import platform
import shutil
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

# Resolve relative to this driver, including importlib-based offline tests.
import importlib.util
_lifecycle_spec = importlib.util.spec_from_file_location(
    'xpod_module_consumer', pathlib.Path(__file__).resolve().parent / 'lib/module-consumer.py')
lifecycle = importlib.util.module_from_spec(_lifecycle_spec)
_lifecycle_spec.loader.exec_module(lifecycle)
require, digest, allocated_bytes = lifecycle.require, lifecycle.digest, lifecycle.allocated_bytes
inside, reference = lifecycle.inside, lifecycle.reference
TRANSPORT, PROBE = lifecycle.TRANSPORT, lifecycle.PROBE
runtime_wrapper, retain_data, inventory = lifecycle.runtime_wrapper, lifecycle.retain_data, lifecycle.inventory

GIB, MIB = lifecycle.GIB, lifecycle.MIB


def validate(plan):
    return lifecycle.validate_consumer_plan(plan, dict(
        id='css', projectionKind='css-product-input-projection',
        projectionFlags=['actualCheckoutVerified', 'exactAttemptAdmitted', 'registryConsumerValidated',
                         'published', 'releaseQualified', 'phaseClosureAdmitted', 'consumerValidated',
                         'legalClearance', 'nativeAdmission'],
        materials={'compiler', 'css-scoped-components', 'css-resource-plan', 'identity-dedup', 'publication', 'css-native-runtime'},
        bindProjection=lambda receipt, producer, declaration: receipt,
        verifyConsumerInput=lambda value, receipt, sha: value.get('schemaVersion') == 1
            and value.get('expectedSourceSha') == sha and value.get('archive') == receipt['archive']
            and value.get('package') == receipt['package']))


class Runner(lifecycle.ModuleConsumerRunner):
    module_id = 'css'
    driver_path = __file__

    def verify_installed(self, runtime, package_root, installed_package):
        native = package_root / 'native/qlever/bin/xpod_qlever_local_runtime'
        binding = json.loads((package_root / 'provenance/css-native-runtime.json').read_text())
        require(binding.get('schemaVersion') == 1 and binding.get('kind') == 'css-native-runtime-byte-binding' and binding.get('target') == self.checked['target']['target'], 'CSS native provenance target differs')
        require(native.is_file() and any(row['path'] == 'native/qlever/bin/xpod_qlever_local_runtime' for row in installed_package['xpodModule']['files']), 'native runtime missing from verified inventory')
        return dict(nativePath=str(native), nativeSha256=digest(native), nativeTargetVerification=lifecycle.targets.native_files(
            package_root, installed_package, self.checked['target']['target'], self.plan['bun'], ['native/qlever/bin/xpod_qlever_local_runtime'], self.module_id))

    def exercise_service(self, runtime, cli, env, cycle, data, package_root, installed_package):
        native = package_root / 'native/qlever/bin/xpod_qlever_local_runtime'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        require(port != 60895, 'reserved old acceptance port allocated; retry explicitly')
        issuer = 'http://localhost:' + str(port) + '/'
        def healthy(process):
            deadline = time.monotonic() + self.plan.get('timeoutSeconds', 180)
            while True:
                self.observe_group(process)
                self.gate()
                require(process.poll() is None, 'CSS exited before discovery')
                try:
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(issuer + '.well-known/openid-configuration', timeout=2) as response:
                        require(response.geturl() == issuer + '.well-known/openid-configuration', 'OIDC redirect rejected')
                        raw = response.read(65537)
                        require(len(raw) <= 65536, 'OIDC discovery too large')
                        discovery = json.loads(raw)
                    break
                except (OSError, ValueError):
                    require(time.monotonic() < deadline, 'OIDC discovery timeout')
                    time.sleep(.2)
            require(discovery.get('issuer') == issuer, 'OIDC issuer mismatch')
            for key in ['authorization_endpoint', 'token_endpoint', 'jwks_uri']:
                url = urllib.parse.urlparse(discovery.get(key, ''))
                require(url.scheme == 'http' and url.hostname == 'localhost' and url.port == port, 'OIDC endpoint mismatch: ' + key)
            children = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,comm='], text=True)
            group = [line for line in children.splitlines() if len(line.split(None, 3)) == 4 and line.split(None, 3)[2] == str(process.pid)]
            qlever = []
            for line in group:
                parts = line.split(None, 3)
                if self.checked['target']['platform'] == 'linux':
                    executable = pathlib.Path('/proc') / parts[0] / 'exe'
                    try:
                        matches = executable.resolve(strict=True) == native.resolve()
                    except FileNotFoundError:
                        matches = False
                else:
                    matches = parts[3] == str(native)
                if matches:
                    qlever.append(line)
            pids = {line.split(None, 3)[0] for line in group}
            require(all(line.split(None, 3)[1] in pids for line in qlever), 'native parent outside service group')
            require(qlever, 'real installed QLever process absent in service group')
            (self.output / (runtime + '-discovery.json')).write_text(json.dumps(dict(discovery=discovery, processGroup=group, qlever=qlever)))
        self.command(runtime + '-css-service', cli + ['start', '--modules', 'css', '--mode', 'local', '--port', str(port), '--baseUrl', issuer, '--data', str(data)], env, cycle, healthy)
        with socket.socket() as sock:
            require(sock.connect_ex(('127.0.0.1', port)) != 0, 'Gateway port still open')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='pinned JSON plan')
    parser.add_argument('--run', action='store_true', help='explicitly execute public CLI consumer; default validates only')
    args = parser.parse_args()
    plan = json.loads(pathlib.Path(args.input).read_text())
    checked = validate(plan)
    if not args.run:
        print(json.dumps(dict(status='validated-dry-run', mutated=False, realConsumerValidated=False, releaseQualified=False, sourceSha=plan['sourceSha'])))
    else:
        runner = Runner(plan, checked)
        runner.run()
        require(runner.result['status'] == 'passed', 'consumer cleanup failed')
        print(json.dumps(runner.result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('CSS consumer: ' + str(error), file=sys.stderr)
        sys.exit(1)
