import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SECRET_BYTES = 32;
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

export type LocalSecretPurpose = 'secret-cell-root-key';

export function localSecretPathForDatabase(databasePath: string, purpose: LocalSecretPurpose): string {
  return path.join(path.dirname(databasePath), '.xpod', 'secrets', purpose);
}

/** Publish complete private key files without replacing an existing identity. */
export function readOrCreateLocalSecret(options: {
  databasePath: string;
  purpose: LocalSecretPurpose;
  label: string;
  isValid: (value: string) => boolean;
}): string {
  const { label } = options;
  const filePath = localSecretPathForDatabase(options.databasePath, options.purpose);
  const privateRoot = path.dirname(options.databasePath);
  const dirPath = path.dirname(filePath);
  try {
    preparePrivateDirectoryPath(privateRoot, dirPath, label);
  } catch (error) {
    throw new Error(`Failed to prepare ${label} directory at ${dirPath}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  if (!fs.existsSync(filePath)) {
    publishNewSecret(filePath, options.purpose, label);
  }

  const secret = readExistingSecret(filePath, label);
  if (!options.isValid(secret)) {
    throw new Error(`${label} file at ${filePath} is invalid; refusing to replace it automatically.`);
  }
  return secret;
}

function publishNewSecret(filePath: string, purpose: LocalSecretPurpose, label: string): void {
  const dirPath = path.dirname(filePath);
  const tempPath = path.join(dirPath, `.${purpose}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
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
      throw new Error(`Failed to create ${label} file at ${filePath}: ${(error as Error).message}`, {
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

function readExistingSecret(filePath: string, label: string): string {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} file at ${filePath} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} file at ${filePath} must be a regular file.`);
  }

  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) {
      throw new Error(`${label} file at ${filePath} must be a regular file.`);
    }
    if (process.platform !== 'win32' && (fdStat.mode & 0o777) !== SECRET_FILE_MODE) {
      throw new Error(`${label} file at ${filePath} must have mode 0600.`);
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

function preparePrivateDirectoryPath(privateRoot: string, dirPath: string, label: string): void {
  const relative = path.relative(privateRoot, dirPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} directory must stay under the identity database directory.`);
  }

  fs.mkdirSync(privateRoot, { recursive: true });
  let current = privateRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: SECRET_DIR_MODE });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} directory at ${current} must not be a symlink.`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} directory at ${current} must be a directory.`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== SECRET_DIR_MODE) {
      throw new Error(`${label} directory at ${current} must have mode 0700.`);
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
