import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../..');

describe('local phone smoke script', () => {
  it('prints a browser verifier URL and direct resource URL for phone validation', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/local-phone-smoke.cjs',
      '--print',
      '--ip', '192.0.2.10',
      '--port', '3456',
      '--path', '/alice/a.txt',
    ], { cwd: root });

    expect(stdout).toContain('Phone URL:    http://192.0.2.10:3456/');
    expect(stdout).toContain('Verifier URL: http://192.0.2.10:3456/app/reachability.html?path=%2Falice%2Fa.txt');
    expect(stdout).toContain('Resource URL: http://192.0.2.10:3456/alice/a.txt');
  });
});
