/**
 * Stable, machine-readable error codes returned alongside HTTP 422 responses.
 */
export const ErrorCode = {
  INVALID_BODY: 'invalid_body',
  INVALID_MAX_CLOCK_SKEW: 'invalid_max_clock_skew',
  INVALID_SPANS: 'invalid_spans',
  INVALID_SPAN: 'invalid_span',
  DUPLICATE_SPAN_ID: 'duplicate_span_id',
  UNKNOWN_PARENT: 'unknown_parent',
  MULTIPLE_ROOTS: 'multiple_roots',
  NO_ROOT: 'no_root',
  CYCLE_DETECTED: 'cycle_detected',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AuditError {
  code: ErrorCodeValue;
  message: string;
  /** Optional JSON-pointer-ish detail for locating the offending span. */
  details?: Record<string, unknown>;
}

export class ValidationFailure extends Error {
  readonly auditError: AuditError;

  constructor(auditError: AuditError) {
    super(auditError.message);
    this.name = 'ValidationFailure';
    this.auditError = auditError;
  }
}
