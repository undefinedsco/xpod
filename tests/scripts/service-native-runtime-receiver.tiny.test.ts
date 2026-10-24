import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native same-FD receiver rejects changed SHA, extra originals, and budget overflow', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'qlever.tests.test_service_native_runtime_receiver'],
    {cwd: root, encoding: 'utf8', timeout: 15000});
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  expect(result.status).toBe(0);
});
