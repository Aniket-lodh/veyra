/**
 * Veyra Error Classes
 */

export class VeyraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeyraError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class VeyraApiError extends VeyraError {
  readonly status: number;
  readonly statusText: string;
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

export class VeyraAuthError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class VeyraNotFoundError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class VeyraConflictError extends VeyraApiError {
  constructor(status: number, statusText: string, message: string, body: unknown) {
    super(status, statusText, message, body);
    this.name = 'VeyraConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class LeaseLostError extends VeyraConflictError {
  constructor(message = 'Job lease was lost or expired') {
    super(409, 'Conflict', message, { error: message });
    this.name = 'LeaseLostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Throwing a NonRetryableError signals to Veyra that the job should fail
 * permanently (dead-lettered immediately) without exhausting max attempts.
 */
export class NonRetryableError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError) {
    return true;
  }
  if (typeof err === 'object' && err !== null && 'permanent' in err) {
    return Boolean((err as { permanent?: boolean }).permanent);
  }
  return false;
}
