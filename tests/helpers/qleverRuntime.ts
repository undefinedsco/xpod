import { accessSync, chmodSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FAKE_QLEVER_LOCAL_RUNTIME_COMMAND = path.resolve(
  __dirname,
  '../fixtures/fake-qlever-native-runtime.js',
);

export interface FakeQleverRuntimeCommand {
  command: string;
  cleanup(): void;
}

export function createFakeQleverRuntimeCommand(): FakeQleverRuntimeCommand {
  const directory = mkdtempSync(path.join(tmpdir(), 'xpod-qlever-runtime-'));
  const command = path.join(directory, 'xpod_qlever_local_runtime');
  writeFileSync(
    command,
    `#!${process.execPath}\nrequire(${JSON.stringify(FAKE_QLEVER_LOCAL_RUNTIME_COMMAND)});\n`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Environment variable that binds the REAL packaged host-native runtime. */
export const NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV = 'XPOD_QLEVER_LOCAL_RUNTIME_NATIVE_COMMAND';
/** Environment variable that binds an immutable Linux runtime image (CI/co-located writer). */
export const NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV = 'XPOD_QLEVER_LOCAL_RUNTIME_IMAGE';
/**
 * Current published immutable Linux runtime for the regular integration gate.
 * Never a mutable tag. `candidate.yml` overrides this with the same-run output.
 */
export const DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE =
  'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:ea5efcbfe5c772ae359260ff01999d9e3169f62f0be5b5eb36e999f545467dd7';
/** Public launcher that runs that image against the local SQLite directory. */
const RUNTIME_IMAGE_LAUNCHER = path.resolve(__dirname, '../../scripts/run-qlever-local-runtime-image.sh');
const IMMUTABLE_IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u;

/**
 * Quote one argument for POSIX shells.
 *
 * `JSON.stringify` is NOT shell escaping: `$`, backticks, `\` and quotes inside
 * a path would be expanded or would break out of the argument. Single quotes are
 * literal in POSIX shells, so wrap the value and close/reopen around any `'`.
 */
export function quoteShellArg(value: string): string {
  if (value.length === 0) {
    return '\'\'';
  }
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}

export interface NativeQleverRuntimeCommand {
  /** Real runtime binary (host-native) or the image launcher's entrypoint. */
  runtime: string;
  /** Launcher the product stack is pointed at: logs one pid, then execs the runtime. */
  command: string;
  /** One line per runtime process started by the suite. */
  ledger: string;
  cleanup(): void;
}

/**
 * Canonical packaged runtime for THIS host, bound explicitly by the caller.
 *
 * The integration runners inject a fake QLever command for every other suite, so
 * a native-freshness case cannot inherit "whatever runtime happens to be bound":
 * it must name the real packaged host-native binary. Callers pass that path via
 * {@link NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV}; there is no fallback, no
 * `:latest`, and no private checkout path baked into this repository.
 *
 * Returns `undefined` only when the caller has not requested a native binding at
 * all (i.e. unit runs). A declared-but-broken binding throws.
 */
export function resolveNativeQleverRuntimeCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]?.trim();
  if (!configured) {
    return undefined;
  }
  // Validate the caller's value BEFORE resolving: `path.resolve` turns any input
  // into an absolute path, so checking it afterwards can never fail.
  if (!path.isAbsolute(configured)) {
    throw new Error(`${NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV} must be an absolute path: ${configured}`);
  }
  return path.resolve(configured);
}

/**
 * Wrap the real runtime in a launcher that appends one ledger line per process
 * and then `exec`s it, so the suite can prove a single native process served
 * every write/read (restart, reopen or per-request replacement would show up as
 * extra lines). The launcher only records a pid; it never inspects or rewrites
 * protocol traffic.
 */
export function createNativeQleverRuntimeCommand(runtime: string): NativeQleverRuntimeCommand {
  assertUsableExecutable(runtime, NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV);
  return createLoggingLauncher(runtime, `exec ${quoteShellArg(runtime)} "$@"`);
}

/**
 * Co-located Linux binding: the published runtime image runs on the SAME host
 * kernel as the SQLite writer, so WAL sharing is real (unlike a Linux container
 * reading a Darwin bind mount). Requires an immutable `@sha256:` reference.
 */
export function createNativeQleverRuntimeImageCommand(image: string): NativeQleverRuntimeCommand {
  if (!IMMUTABLE_IMAGE.test(image)) {
    throw new Error(`${NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV} must be an immutable repo@sha256 reference: ${image}`);
  }
  // Invoked through `bash <path>`; only a regular file is required, matching
  // the tracked mode of the public launcher (100644).
  assertUsableFile(RUNTIME_IMAGE_LAUNCHER, 'run-qlever-local-runtime-image.sh');
  const launcher = [
    `export XPOD_QLEVER_SQLITE_RUNTIME_IMAGE=${quoteShellArg(image)}`,
    `exec bash ${quoteShellArg(RUNTIME_IMAGE_LAUNCHER)} "$@"`,
  ].join('\n');
  return createLoggingLauncher(RUNTIME_IMAGE_LAUNCHER, launcher);
}

function assertUsableFile(target: string, label: string): void {
  if (!existsSync(target)) {
    throw new Error(`${label} is missing at ${target}`);
  }
  if (!statSync(target).isFile()) {
    throw new Error(`${label} is not a regular file at ${target}`);
  }
}

function assertUsableExecutable(target: string, label: string): void {
  assertUsableFile(target, label);
  try {
    accessSync(target, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable at ${target}`);
  }
}

/**
 * Environment the integration runners hand to the native-fresh suite.
 *
 * Precedence: an explicit image (candidate's same-run output) wins, then an
 * explicit host-native binary, then on Linux the current published immutable
 * image. Nothing is mocked or skipped: on a host with no usable binding the
 * suite fails and says which variable to set.
 */
export function nativeQleverRuntimeEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const image = env[NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]?.trim();
  if (image) {
    return { [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: image };
  }
  const native = env[NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]?.trim();
  if (native) {
    return { [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: native };
  }
  return platform === 'linux'
    ? { [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE }
    : {};
}

/**
 * Pick the real runtime binding for the current host.
 *
 * Both supported inputs place the runtime on the SAME OS as the SQLite writer:
 * a host-native packaged binary, or (Linux) an immutable runtime image run in a
 * co-located container on the same kernel. A cross-OS container is rejected by
 * construction: Darwin requires the native binary and never accepts an image.
 */
export function resolveNativeQleverRuntimeBinding(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NativeQleverRuntimeCommand {
  const native = resolveNativeQleverRuntimeCommand(env);
  const image = env[NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]?.trim();
  if (platform !== 'linux' && image && !native) {
    throw new Error(
      `${NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV} is a Linux binding; on ${platform} the runtime `
      + `must be the packaged host-native binary (${NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV}).`,
    );
  }
  if (native) {
    return createNativeQleverRuntimeCommand(native);
  }
  if (image) {
    return createNativeQleverRuntimeImageCommand(image);
  }
  throw new Error(
    `A real QLever runtime is required on ${platform}: set ${NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV} `
    + `to the packaged host-native binary, or ${NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV} to an immutable `
    + 'runtime image on Linux. The fake integration runtime cannot prove SQLite freshness.',
  );
}

function createLoggingLauncher(
  runtime: string,
  body: string,
): NativeQleverRuntimeCommand {
  const directory = mkdtempSync(path.join(tmpdir(), 'xpod-qlever-native-'));
  const ledger = path.join(directory, 'runtime-invocations.log');
  const command = path.join(directory, 'xpod_qlever_local_runtime');
  writeFileSync(
    command,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s pid=%s ppid=%s\\n' "$(date -u +%FT%TZ)" "$$" "$PPID" >> ${quoteShellArg(ledger)}`,
      body,
      '',
    ].join('\n'),
  );
  chmodSync(command, 0o755);
  return {
    runtime,
    command,
    ledger,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
