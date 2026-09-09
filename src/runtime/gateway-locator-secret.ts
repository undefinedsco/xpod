import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteDatabaseFilePath } from './database-url';

const SECRET_BYTES = 32;
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

export function resolvePersistentGatewayLocatorSecret(options: {
  databaseUrl: string;
  edition: 'local' | 'cloud';
}): string {
  if (options.edition === 'cloud') {
    throw new Error('XPOD_GATEWAY_LOCATOR_SECRET is required for Cloud Gateway API keys; configure one stable shared value across replicas.');
  }

  const databasePath = sqliteDatabaseFilePath(options.databaseUrl);
  if (!databasePath) {
    throw new Error('XPOD_GATEWAY_LOCATOR_SECRET is required when CSS_IDENTITY_DB_URL is not a file-backed SQLite database.');
  }

  return readOrCreateSecret(secretPathForDatabase(databasePath), path.dirname(databasePath));
}

export function secretPathForGatewayLocatorDatabase(databaseUrl: string): string | undefined {
  const databasePath = sqliteDatabaseFilePath(databaseUrl);
  return databasePath ? secretPathForDatabase(databasePath) : undefined;
}

function secretPathForDatabase(databasePath: string): string {
  return path.join(path.dirname(databasePath), '.xpod', 'secrets', 'gateway-locator-secret');
}

function readOrCreateSecret(filePath: string, privateRoot: string): string {
  const dirPath = path.dirname(filePath);
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: SECRET_DIR_MODE });
    assertPrivateDirectoryPath(privateRoot, dirPath);
  } catch (error) {
    throw new Error(`Failed to prepare Gateway locator secret directory at ${dirPath}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  if (!fs.existsSync(filePath)) {
    publishNewSecret(filePath);
  }

  const secret = readExistingSecret(filePath);
  if (!isValidSecret(secret)) {
    throw new Error(`Gateway locator secret file at ${filePath} is invalid; refusing to replace it automatically.`);
  }
  return secret;
}

function publishNewSecret(filePath: string): void {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(dirPath, `.gateway-locator-secret.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, 'wx', SECRET_FILE_MODE);
    fs.writeFileSync(fd, `${randomBytes(SECRET_BYTES).toString('base64url')}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tempPath, filePath);
    fsyncDirectory(dirPath);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new Error(`Failed to create Gateway locator secret file at ${filePath}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}

function isValidSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,}$/u.test(value);
}

function readExistingSecret(filePath: string): string {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Gateway locator secret file at ${filePath} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Gateway locator secret file at ${filePath} must be a regular file.`);
  }

  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new Error(`Gateway locator secret file at ${filePath} must be a regular file.`);
    }
    if (process.platform !== 'win32' && (fdStat.mode & 0o777) !== SECRET_FILE_MODE) {
      throw new Error(`Gateway locator secret file at ${filePath} must have mode 0600.`);
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

function assertPrivateDirectoryPath(privateRoot: string, dirPath: string): void {
  const relative = path.relative(privateRoot, dirPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Gateway locator secret directory must stay under the identity database directory.');
  }

  let current = privateRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Gateway locator secret directory at ${current} must not be a symlink.`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Gateway locator secret directory at ${current} must be a directory.`);
    }
  }
}

function fsyncDirectory(dirPath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
