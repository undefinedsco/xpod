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

