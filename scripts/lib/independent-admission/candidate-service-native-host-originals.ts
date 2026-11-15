import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
function need(value: unknown, why: string): asserts value {if (!value) throw Error('Native host originals: ' + why);}
/** Actual retained command/stdio mechanics. No capability or authority is
 * minted here; the caller must supply sole-collector original reads. */
export function inspectNativeHostOriginals(input: {
 identity: {sourceSha: string; sdkImage: string; runtimeImage: string; runtimeConfigDigest: string; runId: number; runAttempt: number; job: string};
 containers: {runtimeContainerId: string; buildContainerId: string};
 window: {started: number; completed: number};
 read(name: string): Buffer; check(): void;
}) {
 const {identity, containers, window} = input;
 need(/^[a-f0-9]{64}$/u.test(containers.runtimeContainerId) && /^[a-f0-9]{64}$/u.test(containers.buildContainerId)
   && containers.runtimeContainerId !== containers.buildContainerId, 'two distinct owned containers');
 need(Number.isFinite(window.started) && Number.isFinite(window.completed) && window.started <= window.completed, 'actual job window');
 const stages = new Map<string, any>();
 function stage(name: string) {
   input.check(); const value = JSON.parse(input.read('host/' + name + '.receipt.json').toString());
   const raw = input.read('host/' + name + '.raw.log');
   const start = Date.parse(value.startedUTC), end = Date.parse(value.closedUTC);
   need(Array.isArray(value.command) && value.command.every((item: unknown) => typeof item === 'string')
     && value.exit === 0 && value.signal === null && value.actualWait === true && value.ownedGroupAbsentAfterWait === true
     && value.rawClosedBeforeHash === true && value.actualRawPipeEof === true && value.rawOverflow === false
     && !value.resourceStop && !value.supervisorError && Array.isArray(value.cleanupErrors) && value.cleanupErrors.length === 0
     && Number.isInteger(value.pid) && value.pid > 0 && value.pgid === value.pid
     && value.retainedRawBytes === raw.length && value.rawSHA256 === createHash('sha256').update(raw).digest('hex')
     && window.started <= start && start <= end && end <= window.completed, 'actual successful closed stage: ' + name);
   stages.set(name, {start, end}); return {command: value.command as string[], text: raw.toString().trim(), start, end};
 }
 const head = stage('host-git-head'); need(head.text === identity.sourceSha, 'actual checkout head');
 need(head.command.length === 5 && head.command[0] === 'git' && head.command[1] === '-C'
   && head.command[3] === 'rev-parse' && head.command[4] === 'HEAD', 'actual Git command');
 const repo = head.command[2]; need(repo.startsWith('/'), 'actual checkout root');
 const pull = stage('host-runtime-pull'); need(isDeepStrictEqual(pull.command, ['docker', 'pull', identity.runtimeImage]), 'immutable runtime pull');
 const inspect = stage('host-runtime-inspect');
 need(isDeepStrictEqual(inspect.command, ['docker', 'image', 'inspect', '--format', '{{.Id}}', identity.runtimeImage])
   && inspect.text === identity.runtimeConfigDigest && inspect.start >= pull.end, 'actual runtime config');
 const create = stage('host-runtime-create'), nonce = create.command[4]?.replace(/^xpod-native-runtime-copy-/u, '');
 need(!!nonce && /^[a-f0-9]+$/u.test(nonce)
   && isDeepStrictEqual(create.command, ['docker', 'create', '--pull=never', '--name', 'xpod-native-runtime-copy-' + nonce,
     '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', identity.runtimeImage])
   && create.text === containers.runtimeContainerId && create.start >= inspect.end, 'actual runtime container');
 const copy = stage('host-runtime-copy');
 need(copy.command.length === 7 && isDeepStrictEqual(copy.command.slice(0, 5), ['python3', repo + '/qlever/scripts/produce-linux-runtime-archive.py', '--bounded-copy', containers.runtimeContainerId, '/opt/xpod/qlever'])
   && /^\d+$/u.test(copy.command[6]) && Number(copy.command[6]) > 0 && Number(copy.command[6]) <= 128 * 1024 ** 2
   && copy.start >= create.end, 'actual bounded runtime copy');
 const tag = 'xpod-native-build-inputs:' + nonce, build = stage('host-build-inputs');
 need(isDeepStrictEqual(build.command, ['docker', 'build', '--file', repo + '/docker/qlever-local-runtime/Dockerfile', '--target', 'build-inputs',
   '--build-arg', 'XPOD_QLEVER_PRIOR_SDK_IMAGE=' + identity.sdkImage, '--tag', tag, repo]) && build.start >= copy.end, 'actual same-SDK focused builder');
 const builder = stage('host-builder-create');
 const args = builder.command, get = (name: string) => {need(args.filter(value => value === name).length === 1, 'unique builder flag ' + name); return args[args.indexOf(name) + 1];};
 need(isDeepStrictEqual(args.slice(0, 5), ['docker', 'create', '--init', '--name', 'xpod-native-build-' + nonce])
   && args.includes(tag) && args.includes('/workspace/xpod/qlever/scripts/sdk-service-native-runtime-originals.py')
   && get('--source-sha') === identity.sourceSha && get('--sdk-image') === identity.sdkImage
   && get('--runtime-image') === identity.runtimeImage && get('--runtime-config-digest') === identity.runtimeConfigDigest
   && get('--run-id') === String(identity.runId) && get('--run-attempt') === String(identity.runAttempt) && get('--job') === identity.job
   && get('--workdir') === '/workspace/xpod' && get('--entrypoint') === 'python3'
   && Number(get('--maximum-bytes')) > 0 && Number(get('--maximum-bytes')) <= 128 * 1024 ** 2
   && builder.text === containers.buildContainerId && builder.start >= build.end, 'actual same-identity inner producer');
 const mountIndices = args.flatMap((arg, index) => arg === '--mount' ? [index] : []);
 need(mountIndices.length === 3, 'exact three owned mounts');
 const mounts = mountIndices.map(index => args[index + 1]);
 need(mounts[0] === 'type=bind,src=' + repo + ',dst=/workspace/xpod,readonly'
   && /^type=bind,src=\/[^,]+,dst=\/run\/xpod-native-inputs,readonly$/u.test(mounts[1])
   && /^type=bind,src=\/[^,]+,dst=\/out$/u.test(mounts[2]), 'fixed native mount scopes');
 const expected = ['docker', 'create', '--init', '--name', 'xpod-native-build-' + nonce,
   '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', 'seccomp=unconfined',
   '--cap-add', 'SYS_PTRACE', '--cap-add', 'SETPCAP',
   '--mount', mounts[0], '--mount', mounts[1], '--mount', mounts[2],
   '--workdir', '/workspace/xpod', '--entrypoint', 'python3', tag, '-I', '-S', '-B',
   '/workspace/xpod/qlever/scripts/sdk-service-native-runtime-originals.py', '--out', '/out/artifact',
   '--source-inventory', '/run/xpod-native-inputs/source-inventory.json', '--runtime-manifest', '/run/xpod-native-inputs/runtime-manifest.json',
   '--source-sha', identity.sourceSha, '--sdk-image', identity.sdkImage, '--runtime-image', identity.runtimeImage,
   '--runtime-config-digest', identity.runtimeConfigDigest, '--run-id', String(identity.runId), '--run-attempt', String(identity.runAttempt),
   '--job', identity.job, '--maximum-bytes', get('--maximum-bytes'), '--deadline-monotonic', get('--deadline-monotonic')];
 need(isDeepStrictEqual(args, expected) && Number.isFinite(Number(get('--deadline-monotonic'))), 'exact fixed builder command');
 const start = stage('host-builder-start'); need(isDeepStrictEqual(start.command, ['docker', 'start', '--attach', containers.buildContainerId]) && start.start >= builder.end, 'actual inner command wait');
 for (const cid of [containers.buildContainerId, containers.runtimeContainerId]) {
   const removed = stage('host-owned-remove-' + cid.slice(0, 12));
   need(isDeepStrictEqual(removed.command, ['docker', 'rm', '--force', '--volumes', cid]) && removed.start >= start.end, 'actual owned cleanup');
 }
 input.check(); return Object.freeze({stageCount: stages.size, checkout: identity.sourceSha, runtimeContainerId: containers.runtimeContainerId, buildContainerId: containers.buildContainerId});
}
