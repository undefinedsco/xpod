export interface CliEnvelope<T = unknown> {
  ok: boolean;
  code: string;
  data?: T;
  message?: string;
  warnings: string[];
  items?: unknown[];
}

export class CliCommandError extends Error {
  public readonly code: string;
  public readonly exitCode: number;
  public readonly data?: unknown;

  public constructor(code: string, message: string, exitCode = 1, data?: unknown) {
    super(message);
    this.name = 'CliCommandError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function ok<T>(data: T, code = 'ok', warnings: string[] = []): CliEnvelope<T> {
  return { ok: true, code, data, warnings };
}

export function fail(code: string, message: string, warnings: string[] = [], data?: unknown): CliEnvelope {
  return { ok: false, code, message, warnings, ...(data === undefined ? {} : { data }) };
}

export function writeJson(result: CliEnvelope): void {
  console.log(JSON.stringify(result, null, 2));
}

export function writeJsonItems(items: unknown[], code: string, warnings: string[] = []): void {
  const ok = items.every((item) => {
    if (!item || typeof item !== 'object' || !('ok' in item)) {
      return false;
    }
    return (item as { ok?: unknown }).ok === true;
  });
  writeJson({ ok, code, items, warnings });
}

export function writeJsonResult<T>(data: T, code = 'ok', warnings: string[] = []): void {
  writeJson(ok(data, code, warnings));
}

export function isJsonMode(argv: { json?: boolean }): boolean {
  return argv.json === true;
}

function shouldForceStructuredError(error: Error): boolean {
  return error instanceof CliCommandError &&
    error.code === 'auth_required' &&
    (process.env.CI === 'true' || !process.stdout.isTTY);
}

export function handleCliError(error: unknown, json: boolean, fallbackCode = 'error'): never {
  const err = error instanceof Error ? error : new Error(String(error));
  if (json || shouldForceStructuredError(err)) {
    if (err instanceof CliCommandError) {
      writeJson(fail(err.code, err.message, [], err.data));
      process.exit(err.exitCode);
    }
    writeJson(fail(fallbackCode, err.message));
    process.exit(1);
  }

  console.error(err.message);
  process.exit(err instanceof CliCommandError ? err.exitCode : 1);
}
