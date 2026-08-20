export type ErrorCode =
  | 'AUDIT_NOT_FOUND'
  | 'CLAIM_NOT_FOUND'
  | 'RECEIPT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_ALLOWED'
  | 'SOURCE_TOO_LARGE'
  | 'PERSISTENCE_ERROR'
  | 'KANE_NOT_AVAILABLE'
  | 'KANE_BLOCKED'
  | 'KANE_INVALID_OUTPUT'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export class ProbatError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProbatError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toProbatError(error: unknown): ProbatError {
  if (error instanceof ProbatError) return error;
  return new ProbatError('INTERNAL_ERROR', 'An unexpected internal error occurred.', 500, {
    cause: errorMessage(error),
  });
}
