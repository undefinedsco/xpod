import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execute = promisify(execFile);

describe('Bun OIDC session cookie integration', () => {
  test.each([['remember', true], ['transient', false]] as const)(
    '%s keeps provider cookie lifetime through the real HTTP response', async (choice, persistent) => {
      const { stdout } = await execute('bun', ['--no-env-file', path.resolve('tests/fixtures/oidc-session-cookie.ts'), choice], {
        timeout: 15_000,
      });
      const result = JSON.parse(stdout.trim());
      expect(result).toMatchObject({ runtime: 'bun', completed: true, interactionCount: 1 });
      expect(result.restoredWithoutInteraction).toBe(persistent);
      expect(result.cookies).toEqual([
        { name: '_session', persistent },
        { name: '_session.sig', persistent },
      ]);
    }, 20_000,
  );
});
