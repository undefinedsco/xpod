import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
