import { Console } from 'node:console'

function handleOutputError(error: NodeJS.ErrnoException): void {
  if (error.code !== 'EPIPE') throw error
}

// Console's temporary error listener does not cover later writes to a pipe
// that already failed. Keep the broken-pipe guard for the stream's lifetime.
process.stdout.on('error', handleOutputError)
process.stderr.on('error', handleOutputError)

// A launcher can close its output pipes while the resident app keeps running.
// Logging must not turn that transport failure into an Electron exception dialog.
export const desktopConsole = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
  ignoreErrors: true,
})
