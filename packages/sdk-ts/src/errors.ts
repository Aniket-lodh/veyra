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
 *
 * @example
 * ```ts
 * try {
 *   await client.getJob('missing');
 * } catch (err) {
 *   if (err instanceof VeyraError) console.error(err.message);
 * }
 * ```
 */
export class VeyraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeyraError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Non-2xx HTTP response from the Veyra API.
 * The API always returns `{ "error": string }`, available on {@link body}.
 */
export class VeyraApiError extends VeyraError {
  /** HTTP status code. */
  readonly status: number;
  /** HTTP status text. */
  readonly statusText: string;
  /** Parsed response body, typically `{ error: string }`. */
  readonly body: unknown;

  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(message);
    this.name = 'VeyraApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `401` or `403`: missing, invalid, or insufficiently scoped API key. */
export class VeyraAuthError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `404`: the job or worker does not exist. */
export class VeyraNotFoundError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `409`: the request conflicts with current queue or worker state. */
export class VeyraConflictError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `409` caused by an expired, reclaimed, or reassigned job lease.
 * The worker aborts the job's {@link JobContext.signal} when this is raised.
 */
export class LeaseLostError extends VeyraConflictError {
  constructor(message = 'Job lease was lost or expired') {
    super(409, 'Conflict', message, { error: message });
    this.name = 'LeaseLostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Throw from a handler to fail the job permanently: no further attempts, the
 * job is dead-lettered immediately.
 *
 * @example
 * ```ts
 * worker.register('send_email', async (job) => {
 *   if (!job.payload.to) throw new NonRetryableError('missing recipient');
 *   return { sent: true };
 * });
 * ```
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
 * A payload or result did not satisfy its Standard Schema.
 * Permanent by design: retrying cannot fix a shape mismatch.
 */
export class VeyraValidationError extends VeyraError {
  /** Context label, e.g. `handler 'send_email' payload`. */
  readonly label: string;
  /** Structured issues returned by the schema. */
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;
  /** Signals permanent failure to the Veyra worker runtime. */
  readonly permanent = true;

  constructor(label: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    const detail = issues
      .map((issue) => {
        const path = formatIssuePath(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    super(`${label} validation failed${detail ? `: ${detail}` : ''}`);
    this.name = 'VeyraValidationError';
    this.label = label;
    this.issues = issues;
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
