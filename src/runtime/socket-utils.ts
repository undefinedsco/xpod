import fs from 'node:fs';
import path from 'node:path';

export function prepareSocketPath(socketPath: string): void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  removeSocketPath(socketPath);
}

export function removeSocketPath(socketPath: string): void {
  if (!fs.existsSync(socketPath)) {
    return;
  }

  try {
    const stat = fs.statSync(socketPath);
    if (!stat.isSocket()) {
      return;
    }
  } catch {
    return;
  }

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore cleanup errors
  }
}
