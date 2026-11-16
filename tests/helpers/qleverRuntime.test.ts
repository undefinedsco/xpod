import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE,
  NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV,
  NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV,
  nativeQleverRuntimeEnv,
  quoteShellArg,
  resolveNativeQleverRuntimeBinding,
} from './qleverRuntime';

const cleans: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
  while (cleans.length > 0) cleans.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Benign, executable fixture binary; the launcher is never executed here. */
function executableFixture(name = 'xpod_qlever_local_runtime'): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'xpod-qlever-fixture-'));
  dirs.push(directory);
  const file = path.join(directory, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}

const IMAGE = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:ea5efcbfe5c772ae359260ff01999d9e3169f62f0be5b5eb36e999f545467dd7';

describe('native QLever runtime fixture binding', () => {
  it('rejects a relative runtime path before resolution can hide it', () => {
    expect(() => resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: 'relative/bin/xpod_qlever_local_runtime',
    })).toThrow(/must be an absolute path/u);
    expect(() => resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: './xpod_qlever_local_runtime',
    })).toThrow(/must be an absolute path/u);
  });

  it('fails for a missing or non-executable runtime instead of falling back to fake', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xpod-qlever-notexec-'));
    dirs.push(directory);
    const notExecutable = path.join(directory, 'xpod_qlever_local_runtime');
    writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
    chmodSync(notExecutable, 0o644);

    expect(() => resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: path.join(directory, 'absent'),
    })).toThrow(/is missing at/u);
    expect(() => resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: notExecutable,
    })).toThrow(/not executable at/u);
    expect(() => resolveNativeQleverRuntimeBinding('linux', {})).toThrow(/real QLever runtime is required/u);
    expect(() => resolveNativeQleverRuntimeBinding('linux', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: 'ghcr.io/undefinedsco/xpod-qlever-local-runtime:latest',
    })).toThrow(/immutable repo@sha256/u);
  });

  it('quotes emitted shell arguments rather than JSON-stringifying them', () => {
    expect(quoteShellArg('/plain/path')).toBe('\'/plain/path\'');
    expect(quoteShellArg('')).toBe('\'\'');
    // `$`, backticks and backslashes stay literal inside single quotes.
    expect(quoteShellArg('/a $HOME `id` \\b')).toBe('\'/a $HOME `id` \\b\'');
    // A single quote is the only character that must close/reopen the quote.
    expect(quoteShellArg('a\'b')).toBe('\'a\'\\\'\'b\'');

    const hostile = executableFixture('xpod $HOME `id` \'q\' \\ b');
    const bound = resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: hostile,
    });
    cleans.push(bound.cleanup);
    const launcher = readFileSync(bound.command, 'utf8');
    expect(launcher).toContain(`exec ${quoteShellArg(hostile)} "$@"`);
    expect(launcher).not.toContain(`exec ${JSON.stringify(hostile)}`);
    expect(launcher).toContain(quoteShellArg(bound.ledger));
  });

  it('executes the generated launcher for a hostile path without shell expansion', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xpod-qlever-exec-'));
    dirs.push(directory);
    const echo = path.join(directory, 'echo $HOME `id` \'q\' \\ arg');
    writeFileSync(echo, '#!/bin/sh\nprintf %s\\n "$@"\n');
    chmodSync(echo, 0o755);

    const bound = resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: echo,
    });
    cleans.push(bound.cleanup);
    const dbPath = path.join(directory, 'rdf index.sqlite');
    const result = spawnSync(bound.command, [ '--sqlite-path', dbPath ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    // The fixture printed its argv. A `$HOME`/backtick expansion or quote break
    // would either lose the argument or run `id` instead of the fixture.
    expect(result.stdout).toContain('--sqlite-path');
    expect(result.stdout).toContain(dbPath);
    const ledgerLines = readFileSync(bound.ledger, 'utf8').trim().split('\n');
    expect(ledgerLines).toHaveLength(1);
  });

  it('hands the regular Linux gate the current immutable runtime image by default', () => {
    // The CI jobs keep their tracked workflow bytes; the runner is the canonical
    // binding entrypoint, so the required native case is never silently skipped.
    expect(nativeQleverRuntimeEnv('linux', {})).toEqual({
      [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE,
    });
    expect(DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(DEFAULT_NATIVE_QLEVER_RUNTIME_IMAGE).not.toContain(':latest');
    // No silent default on a non-Linux host: it must be bound explicitly.
    expect(nativeQleverRuntimeEnv('darwin', {})).toEqual({});
  });

  it('lets an explicit binding win over the default image', () => {
    const image = 'ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:' + 'a'.repeat(64);
    expect(nativeQleverRuntimeEnv('linux', { [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: image })).toEqual({
      [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: image,
    });
    const native = executableFixture();
    expect(nativeQleverRuntimeEnv('linux', { [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: native })).toEqual({
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: native,
    });
    expect(nativeQleverRuntimeEnv('darwin', { [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: native })).toEqual({
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: native,
    });
  });

  it('binds the host-native binary on Darwin and rejects a Linux image there', () => {
    const runtime = executableFixture();
    const bound = resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: runtime,
    });
    cleans.push(bound.cleanup);
    expect(bound.runtime).toBe(runtime);
    expect(existsSync(bound.command)).toBe(true);
    expect(existsSync(bound.ledger)).toBe(false);

    expect(() => resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: IMAGE,
    })).toThrow(/Linux binding/u);
  });

  it('accepts an immutable image on Linux through the public launcher', () => {
    const bound = resolveNativeQleverRuntimeBinding('linux', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_IMAGE_ENV]: IMAGE,
    });
    cleans.push(bound.cleanup);
    const launcher = readFileSync(bound.command, 'utf8');
    expect(launcher).toContain(quoteShellArg(IMAGE));
    expect(launcher).toContain('run-qlever-local-runtime-image.sh');
    expect(launcher).not.toContain(':latest');
  });

  it('logs one pid line per started process, not per request', () => {
    const bound = resolveNativeQleverRuntimeBinding('darwin', {
      [NATIVE_QLEVER_LOCAL_RUNTIME_COMMAND_ENV]: executableFixture(),
    });
    cleans.push(bound.cleanup);
    expect(existsSync(bound.ledger)).toBe(false);
    expect(readFileSync(bound.command, 'utf8')).toContain(quoteShellArg(bound.ledger));
  });
});
