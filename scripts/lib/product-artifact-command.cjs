// One existing Python selector and one bounded original diagnostic path; no fallback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function pythonInvocation(platform = process.platform) { return { command: platform === 'win32' ? 'python' : 'python3', args: [] }; }
const REQUEST_LIMIT = 8 * 1024 ** 2;
function inspectArtifact(args, { evidence, label, timeout, maxBuffer, input }, execute = spawnSync) {
  const invocation = pythonInvocation();
  const argv = [...invocation.args, ...args];
  const request = input == null ? null : Buffer.isBuffer(input) ? input : Buffer.from(input);
  const spawnAttempted = !request || request.length <= REQUEST_LIMIT;
  const result = spawnAttempted ? execute(invocation.command, argv, { timeout, maxBuffer, ...(request ? { input: request } : {}) })
    : { status: null, signal: null, error: Object.assign(new Error('Projection request exceeds bounded stdin limit'), { code: 'ERR_PROJECTION_REQUEST_BOUND' }) };
  const bytes = value => value == null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(value);
  const stdout = bytes(result.stdout), stderr = bytes(result.stderr);
  const primary = result.error ?? (result.status !== 0 || result.signal ? Object.assign(new Error('Artifact inspection child failed'), { outcome: { command: invocation.command, args: argv, status: result.status, signal: result.signal } }) : null);
  if (evidence) {
    try {
      if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid diagnostic label');
      const absolute = path.resolve(evidence); let current = path.parse(absolute).root;
      for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked diagnostic ancestor');
      }
      const directory = fs.mkdtempSync(path.join(evidence, label + '-'));
      const retain = (channel, content, file = channel + '.raw.log', maximum = maxBuffer) => {
        const captured = content.subarray(0, maximum);
        fs.writeFileSync(path.join(directory, file), captured, { flag: 'wx', mode: 0o600 });
        return { path: file, bytes: captured.length, sha256: crypto.createHash('sha256').update(captured).digest('hex'), captureTruncated: content.length !== captured.length };
      };
      const receipt = { command: invocation.command, args: argv, spawnAttempted, status: result.status ?? null, signal: result.signal ?? null,
        error: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code ?? null, errno: result.error.errno ?? null, syscall: result.error.syscall ?? null } : null,
        timeoutMs: timeout, maxBufferBytes: maxBuffer, ...(request ? { stdin: { ...retain('request', request, 'request.original.json', REQUEST_LIMIT), transport: 'stdin-json', sourceBytes: request.length, sourceSHA256: crypto.createHash('sha256').update(request).digest('hex'), limitBytes: REQUEST_LIMIT } } : {}), stdout: retain('stdout', stdout), stderr: retain('stderr', stderr),
        scope: spawnAttempted ? 'spawnSync observed return, bounded output captures and original stdin input only; no process-group or detached descendant closure claim' : 'Request rejected before spawn; bounded original input capture only' };
      fs.writeFileSync(path.join(directory, 'command.original.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (secondary) { throw primary ? new AggregateError([primary, secondary], 'Artifact inspection and diagnostic retention failed', { cause: primary }) : secondary; }
  }
  return { ...result, status: result.status ?? null, signal: result.signal ?? null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
}
module.exports = { pythonInvocation, inspectArtifact, REQUEST_LIMIT };
