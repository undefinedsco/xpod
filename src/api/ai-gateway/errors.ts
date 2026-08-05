export type GatewayErrorCode =
  | 'invalid_request'
  | 'invalid_tool_arguments'
  | 'unsupported_protocol_event'
  | 'service_access_missing'
  | 'credential_unavailable'
  | 'model_not_available'
  | 'no_model_available'
  | 'provider_error'
  | 'internal_error';

export interface NormalizedGatewayError {
  error: {
    code: GatewayErrorCode;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  };
}

export class GatewayProtocolError extends Error {
  public readonly code: GatewayErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  public constructor(message: string, options: {
    code?: GatewayErrorCode;
    status?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = 'GatewayProtocolError';
    this.code = options.code ?? 'invalid_request';
    this.status = options.status ?? 400;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function normalizeGatewayError(error: unknown): NormalizedGatewayError {
  if (error instanceof GatewayProtocolError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  if (error instanceof Error && error.message === 'service_access_missing') {
    return {
      error: {
        code: 'service_access_missing',
        message: 'Pod service access is missing or has been revoked',
        status: 403,
      },
    };
  }

  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500;
  const message = error instanceof Error ? error.message : 'Unknown gateway error';

  return {
    error: {
      code: status >= 500 ? 'internal_error' : 'provider_error',
      message,
      status,
    },
  };
}
