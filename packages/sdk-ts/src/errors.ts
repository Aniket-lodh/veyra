/**
 * Error types thrown by the Veyra SDK.
 */

import type { StandardSchemaV1 } from './standard-schema.js';

function formatIssuePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined
): string {
  if (!path || path.length === 0) {
    return '';
  }
  return path
    .map((segment) =>
      typeof segment === 'object' && segment !== null && 'key' in segment
        ? String(segment.key)
        : String(segment)
    )
    .join('.');
}

/**
 * Base error for every SDK failure.
 */
export class VeyraError extends Error {
  /** Error code identifying the failure class. */
  readonly code: string;
  /** Underlying cause if available. */
  override readonly cause?: unknown;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message);
    this.name = 'VeyraError';
    this.code = options?.code ?? 'VEYRA_ERROR';
    this.cause = options?.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A payload, result, or configuration argument did not satisfy validation rules.
 * Permanent by design: retrying without fixing input cannot succeed.
 */
export class VeyraValidationError extends VeyraError {
  /** Context label, e.g. `handler 'send_email' payload`. */
  readonly label: string;
  /** Structured issues describing the validation failures. */
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;
  /** Signals permanent failure to the Veyra worker runtime. */
  readonly permanent = true;

  constructor(
    label: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
    options?: { cause?: unknown }
  ) {
    const detail = issues
      .map((issue) => {
        const path = formatIssuePath(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    super(`${label} validation failed${detail ? `: ${detail}` : ''}`, {
      code: 'VALIDATION_ERROR',
      cause: options?.cause,
    });
    this.name = 'VeyraValidationError';
    this.label = label;
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Parameters object accepted by {@link VeyraApiError}. */
export interface VeyraApiErrorParams {
  status: number;
  statusText: string;
  message: string;
  body: unknown;
  requestId?: string;
  retryable?: boolean;
  code?: string;
  cause?: unknown;
}

/**
 * Non-2xx HTTP response from the Veyra API.
 */
export class VeyraApiError extends VeyraError {
  /** HTTP status code. */
  readonly status: number;
  /** HTTP status text. */
  readonly statusText: string;
  /** Unique request ID assigned by Veyra API (`X-Request-Id`), if present. */
  readonly requestId?: string;
  /** Whether this failure is safe to retry automatically. */
  readonly retryable: boolean;
  /** Parsed response body or error excerpt. */
  readonly body: unknown;

  constructor(
    statusOrParams: number | VeyraApiErrorParams,
    statusText?: string,
    message?: string,
    body?: unknown,
    options?: { requestId?: string; retryable?: boolean; code?: string; cause?: unknown }
  ) {
    if (typeof statusOrParams === 'object') {
      const p = statusOrParams;
      super(p.message, { code: p.code ?? 'API_ERROR', cause: p.cause });
      this.name = 'VeyraApiError';
      this.status = p.status;
      this.statusText = p.statusText;
      this.body = p.body;
      this.requestId = p.requestId;
      this.retryable = p.retryable ?? (p.status >= 500 && p.status !== 501);
    } else {
      super(message ?? `HTTP ${statusOrParams}`, {
        code: options?.code ?? 'API_ERROR',
        cause: options?.cause,
      });
      this.name = 'VeyraApiError';
      this.status = statusOrParams;
      this.statusText = statusText ?? '';
      this.body = body;
      this.requestId = options?.requestId;
      this.retryable = options?.retryable ?? (statusOrParams >= 500 && statusOrParams !== 501);
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `401` or `403`: missing, invalid, or insufficiently scoped API key. */
export class VeyraAuthError extends VeyraApiError {
  constructor(
    statusOrParams: number | VeyraApiErrorParams,
    statusText?: string,
    message?: string,
    body?: unknown,
    options?: { requestId?: string; cause?: unknown }
  ) {
    if (typeof statusOrParams === 'object') {
      super({ ...statusOrParams, code: 'AUTH_ERROR', retryable: false });
    } else {
      super(statusOrParams, statusText, message, body, {
        ...options,
        code: 'AUTH_ERROR',
        retryable: false,
      });
    }
    this.name = 'VeyraAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `404`: the requested job, worker, or resource was not found. */
export class VeyraNotFoundError extends VeyraApiError {
  constructor(
    statusOrParams: number | VeyraApiErrorParams,
    statusText?: string,
    message?: string,
    body?: unknown,
    options?: { requestId?: string; cause?: unknown }
  ) {
    if (typeof statusOrParams === 'object') {
      super({ ...statusOrParams, code: 'NOT_FOUND', retryable: false });
    } else {
      super(statusOrParams, statusText, message, body, {
        ...options,
        code: 'NOT_FOUND',
        retryable: false,
      });
    }
    this.name = 'VeyraNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `409`: the request conflicts with current queue or worker state. */
export class VeyraConflictError extends VeyraApiError {
  constructor(
    statusOrParams: number | VeyraApiErrorParams,
    statusText?: string,
    message?: string,
    body?: unknown,
    options?: { requestId?: string; cause?: unknown; code?: string }
  ) {
    if (typeof statusOrParams === 'object') {
      super({
        ...statusOrParams,
        code: statusOrParams.code ?? 'CONFLICT',
        retryable: false,
      });
    } else {
      super(statusOrParams, statusText, message, body, {
        ...options,
        code: options?.code ?? 'CONFLICT',
        retryable: false,
      });
    }
    this.name = 'VeyraConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `409` caused by an expired, reclaimed, or reassigned job lease.
 * The worker aborts the job's execution context signal when this is raised.
 */
export class LeaseLostError extends VeyraConflictError {
  constructor(
    message = 'Job lease was lost or expired',
    options?: { requestId?: string; cause?: unknown }
  ) {
    super(409, 'Conflict', message, { error: message }, {
      requestId: options?.requestId,
      cause: options?.cause,
      code: 'LEASE_LOST',
    });
    this.name = 'LeaseLostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `429`: rate limit exceeded. Automatically retried when retries are enabled. */
export class VeyraRateLimitError extends VeyraApiError {
  /** Suggested backoff in milliseconds parsed from `Retry-After` header, if provided. */
  readonly retryAfterMs?: number;

  constructor(
    statusOrParams: number | (VeyraApiErrorParams & { retryAfterMs?: number }),
    statusText?: string,
    message?: string,
    body?: unknown,
    options?: { requestId?: string; retryAfterMs?: number; cause?: unknown }
  ) {
    if (typeof statusOrParams === 'object') {
      super({ ...statusOrParams, code: 'RATE_LIMIT_EXCEEDED', retryable: true });
      this.retryAfterMs = statusOrParams.retryAfterMs;
    } else {
      super(statusOrParams, statusText, message, body, {
        ...options,
        code: 'RATE_LIMIT_EXCEEDED',
        retryable: true,
      });
      this.retryAfterMs = options?.retryAfterMs;
    }
    this.name = 'VeyraRateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Request exceeded its timeout deadline. */
export class VeyraTimeoutError extends VeyraError {
  /** Configured timeout in milliseconds that was exceeded. */
  readonly timeoutMs: number;
  /** Timeouts are safe to retry on idempotent requests. */
  readonly retryable = true;

  constructor(message: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(message, { code: 'TIMEOUT', cause: options?.cause });
    this.name = 'VeyraTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network-level transport error (DNS lookup failure, connection refused, connection reset). */
export class VeyraNetworkError extends VeyraError {
  /** Network transport errors are safe to retry on idempotent requests. */
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { code: 'NETWORK_ERROR', cause: options?.cause });
    this.name = 'VeyraNetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Webhook HMAC signature verification failure or malformed webhook payload. */
export class VeyraWebhookError extends VeyraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { code: 'WEBHOOK_ERROR', cause: options?.cause });
    this.name = 'VeyraWebhookError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Throw from a worker handler to fail the job permanently: no further attempts,
 * the job is dead-lettered immediately.
 */
export class NonRetryableError extends Error {
  /** Signals permanent failure to the Veyra worker runtime. */
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Returns `true` when an error asks the worker to skip retries.
 * Honours {@link NonRetryableError}, {@link VeyraValidationError}, and any
 * error object with `permanent: true`.
 */
export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'permanent' in err) {
    return Boolean((err as { permanent?: boolean }).permanent);
  }
  return false;
}
