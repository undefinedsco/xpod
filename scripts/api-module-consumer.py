#!/usr/bin/env python3
"""Pinned installed API public-CLI consumer. Default validates without running.

The plan matches the CSS consumer with apiReceipt/apiArchive in place of the
CSS references. Only --run installs, starts, probes and removes the module.
"""
import argparse
import importlib.util
import json
import pathlib
import socket
import sys
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).resolve().parent / 'lib' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lifecycle = load('xpod_module_consumer', 'module-consumer.py')
probes = load('xpod_api_consumer_probes', 'api-consumer-probes.py')
inngest = load('xpod_inngest_runtime_probe', 'inngest-runtime-probe.py')
require = lifecycle.require


def bind_projection(receipt, producer, declaration):
    context = producer['context']
    require(context.get('target') == declaration['target'], 'API target mismatch')
    return dict(receipt, archive=producer['archive'], consumerInput=receipt['collectorInput'], package=dict(
        name=declaration['name'], target=context['target'], version=context['version']))


def validate(plan):
    material_members = dict(
        sourceInventory='package/provenance/source-inventory.json',
        releaseStatus='package/provenance/release-status.json',
        publication='package/provenance/publication.json',
        termsIndex='package/provenance/terms/index.json',
        nativeIndex='package/provenance/native/inngest/index.json')
    return lifecycle.validate_consumer_plan(plan, dict(
        id='api', projectionKind='api-product-input-projection',
        projectionFlags=['actualCheckoutVerified', 'exactAttemptAdmitted', 'collectorExecuted', 'published', 'releaseQualified'],
        materials=set(),
        verifyMaterials=lambda rows: {key: row.get('archiveMember') for key, row in rows.items()} == material_members,
        bindProjection=bind_projection,
        verifyConsumerInput=lambda value, receipt, sha: value.get('schemaVersion') == 1
            and value.get('expectedSourceSha') == sha and value.get('archive') == dict(
                path='product.tgz', sha256=receipt['archive']['sha256'])))


class Runner(lifecycle.ModuleConsumerRunner):
    module_id = 'api'
    driver_path = __file__
    additional_drivers = [pathlib.Path(probes.__file__),pathlib.Path(inngest.__file__),pathlib.Path(inngest.__file__).with_name('inngest-runtime-policy.json')]

    def total_deadline_seconds(self):
        return super().total_deadline_seconds()+inngest.additional_seconds()

    def command_timeout_seconds(self, label):
        fixed={runtime+'-'+role for runtime in inngest.POLICY['profiles'] for role in ['inngest-version','inngest-loader']}
        return min(super().command_timeout_seconds(label),inngest.POLICY['commandSeconds']) if label in fixed else super().command_timeout_seconds(label)

    def verify_installed(self, runtime, package_root, installed_package):
        require(installed_package['xpodModule']['id'] == 'api', 'installed API module id differs')
        declaration = self.checked['target']
        native_index = json.loads((package_root / 'provenance/native/inngest/index.json').read_text())
        require(native_index.get('platform') == declaration['platform'] and native_index.get('arch') == declaration['arch'], 'Inngest provenance target differs')
        require(native_index.get('binarySHA256') == lifecycle.digest(package_root / 'node_modules/inngest-cli/bin/inngest'), 'Inngest provenance bytes differ')
        return dict(nativeTargetVerification=lifecycle.targets.native_files(package_root, installed_package,
            self.checked['target']['target'], self.plan['bun'], ['node_modules/inngest-cli/bin/inngest'], self.module_id))

    def exercise_service(self, runtime, cli, env, cycle, data, package_root, installed_package):
        inngest.capture(self,runtime,cli,env,cycle,package_root,installed_package)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        require(port != 60895, 'reserved old acceptance port allocated; retry explicitly')
        base = 'http://127.0.0.1:' + str(port) + '/'
        api_env = dict(env, XPOD_EDITION='cloud', CSS_IDENTITY_DB_URL='sqlite::memory:',
                       API_HOST='127.0.0.1', API_PORT=str(port), CSS_BASE_URL=base,
                       CSS_ROOT_FILE_PATH=str(data / 'api'), CSS_LOGGING_LEVEL='warn',
                       XPOD_INNGEST_ENABLED='false', XPOD_NODE_ID='module-consumer-' + runtime)
        self.command(runtime + '-api-service', cli + ['api'], api_env, cycle,
                     lambda process: probes.healthy(self, process, base, package_root, runtime))
        sandbox = cli[:-1]
        pglite = probes.write_probe(cycle, 'pglite')
        self.command(runtime + '-pglite', sandbox + [self.plan[runtime], str(pglite), str(package_root)], env, cycle)
        rdf = probes.write_probe(cycle, 'rdf')
        label = runtime + '-api-rdf'
        def query_ready(process):
            probes.healthy(self, process, base, package_root, runtime + '-rdf')
            deadline = time.monotonic() + self.plan.get('timeoutSeconds', 180)
            raw = self.output / (label + '.stdout.raw.log')
            while True:
                self.observe_group(process)
                self.gate()
                require(process.poll() is None, 'API RDF process exited before query receipt')
                with raw.open('rb') as stream:
                    body = stream.read(1024 * 1024 + 1)
                require(len(body) <= 1024 * 1024, 'API RDF diagnostic exceeds bound')
                for line in body.splitlines():
                    try:
                        value = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if value == dict(rdf=True, bindingsStreamClosed=True, actualApiPatchedObserverPrototypeShared=True):
                        return
                require(time.monotonic() < deadline, 'API RDF query deadline')
                time.sleep(.2)
        self.command(label, sandbox + [self.plan[runtime], str(rdf), str(package_root)], api_env, cycle, query_ready)
        with socket.socket() as sock:
            require(sock.connect_ex(('127.0.0.1', port)) != 0, 'API port still open')
        self.result['installedVerification'][runtime]['dependencyProbes'] = dict(pglite=True, rdf=True, sharedObserver=True)
        self.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='pinned JSON plan')
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    plan = json.loads(pathlib.Path(args.input).read_text())
    checked = validate(plan)
    if not args.run:
        print(json.dumps(dict(status='validated-dry-run', mutated=False, realConsumerValidated=False,
                              releaseQualified=False, sourceSha=plan['sourceSha'])))
        return
    runner = Runner(plan, checked)
    runner.run()
    require(runner.result['status'] == 'passed', 'API consumer cleanup failed')
    print(json.dumps(runner.result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('API consumer: ' + str(error), file=sys.stderr)
        sys.exit(1)
