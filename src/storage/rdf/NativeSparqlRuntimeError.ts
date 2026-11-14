export type LocalQleverRuntimeErrorCode =
  | 'qlever_runtime_unavailable'
  | 'qlever_runtime_protocol_error'
  | 'qlever_runtime_closed'
  | 'qlever_request_timeout'
  | 'qlever_request_aborted'
  | 'qlever_remote_error';

export class LocalQleverRuntimeError extends Error {
  public readonly code: LocalQleverRuntimeErrorCode | string;
  public override readonly cause?: unknown;

  public constructor(code: LocalQleverRuntimeErrorCode | string, message: string, cause?: unknown) {
    super(message);
    this.name = 'LocalQleverRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

