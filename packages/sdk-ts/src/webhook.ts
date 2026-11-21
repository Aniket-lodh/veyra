/**
 * Typed completion webhooks: signature verification and payload parsing.
 */

import { VeyraValidationError, VeyraWebhookError } from './errors.js';
import { isHandlerDefinition } from './handlers.js';
import type { HandlerDefinition } from './handlers.js';
import { validateWithSchema } from './standard-schema.js';
import type { JobError } from './types.js';

/** Terminal statuses that trigger a webhook delivery. */
export type WebhookJobStatus = 'succeeded' | 'dead_lettered' | 'cancelled';

/**
 * Body delivered to `callbackUrl` when a job reaches a terminal state.
 *
 * @typeParam TResult - Shape of `result`.
 */
export interface WebhookEvent<TResult = unknown> {
  /** Always `job.completed`. */
  event: 'job.completed';
  /** Job ULID. */
  jobId: string;
  /** Queue name. */
  queue: string;
  /** Handler name. */
  handler: string;
  /** Terminal storage status. */
  status: WebhookJobStatus;
  /** Attempts made. */
  attempt: number;
  /** Per-job retry ceiling. */
  maxAttempts: number;
  /** Payload supplied at enqueue. */
  payload: unknown;
  /** Handler result, or `null` for failures and cancellations. */
  result: TResult | null;
  /** Structured failure, or `null`. */
  error: JobError | null;
  /** RFC 3339 enqueue timestamp. */
  enqueuedAt: string;
  /** RFC 3339 attempt start, or `null`. */
  startedAt: string | null;
  /** RFC 3339 success timestamp, or `null`. */
  completedAt: string | null;
  /** RFC 3339 cancellation timestamp, or `null`. */
  cancelledAt: string | null;
  /** RFC 3339 dead-letter timestamp, or `null`. */
  deadLetteredAt: string | null;
  /** 1-based webhook delivery attempt. */
  callbackAttempts: number;
}

/** Signature options for {@link parseWebhook}. */
export interface WebhookVerificationOptions {
  /** Shared secret configured as `VEYRA_CALLBACK_SECRET` on the API. */
  secret?: string;
  /** Raw `X-Veyra-Signature` header value, e.g. `sha256=ab12...`. */
  signature?: string | null;
}

function toBytes(body: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new VeyraValidationError('rawBody', [
    { message: 'rawBody must be a string, Uint8Array, or ArrayBuffer' },
  ]);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const subtle =
    globalThis.crypto?.subtle ??
    (await import('node:crypto').catch(() => undefined))?.webcrypto?.subtle;
  if (!subtle) {
    throw new VeyraWebhookError(
      'Webhook signatures require Web Crypto (globalThis.crypto.subtle) or Node 18+ crypto.'
    );
  }
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(
    await subtle.sign('HMAC', key, data as unknown as BufferSource)
  );
}

/**
 * Constant-time byte comparison using Node's `crypto.timingSafeEqual` where available,
 * falling back to a bitwise constant-time loop. Guards lengths first to prevent RangeError.
 */
async function timingSafeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  try {
    const nodeCrypto = await import('node:crypto');
    if (typeof nodeCrypto.timingSafeEqual === 'function') {
      return nodeCrypto.timingSafeEqual(a, b);
    }
  } catch {
    // Non-Node environment or module unavailable; use bitwise fallback below
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verifies the `X-Veyra-Signature` header: `sha256=<hex HMAC-SHA256(rawBody)>`.
 * Comparison is strictly constant-time and lengths are guarded to prevent `RangeError`.
 *
 * @param rawBody - Exact request body bytes (do not re-serialize JSON).
 * @param signature - `X-Veyra-Signature` header value.
 * @param secret - Shared secret configured as `VEYRA_CALLBACK_SECRET` on the API.
 * @returns `true` when the signature matches.
 *
 * @example
 * ```ts
 * const ok = await verifyWebhookSignature(rawBody, req.headers['x-veyra-signature'], secret);
 * ```
 */
export async function verifyWebhookSignature(
  rawBody: string | ArrayBuffer | ArrayBufferView,
  signature: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signature || typeof signature !== 'string') {
    return false;
  }
  if (!secret || typeof secret !== 'string') {
    return false;
  }
  const separator = signature.indexOf('=');
  if (separator === -1 || signature.slice(0, separator).toLowerCase() !== 'sha256') {
    return false;
  }
  const providedHex = signature.slice(separator + 1).trim();
  const providedBytes = hexToBytes(providedHex);
  if (!providedBytes) {
    return false;
  }

  const expectedBytes = await hmacSha256(secret, toBytes(rawBody));
  return timingSafeEqual(expectedBytes, providedBytes);
}

/**
 * Verifies (when a secret is supplied), parses, and optionally validates a
 * completion webhook.
 *
 * @param rawBody - Exact request body bytes.
 * @param handler - Optional definition whose result schema validates `event.result`.
 * @param options - HMAC secret and signature header.
 * @returns The typed webhook event.
 * @throws {VeyraWebhookError} When the signature is missing/invalid or the body is not JSON.
 * @throws {VeyraValidationError} When `event.result` fails the definition's result schema.
 *
 * @example
 * ```ts
 * const event = await parseWebhook(rawBody, sendEmail, {
 *   secret: process.env.VEYRA_CALLBACK_SECRET,
 *   signature: req.headers['x-veyra-signature'],
 * });
 * event.result?.messageId; // string | null
 * ```
 */
export async function parseWebhook<
  TName extends string,
  TPayload,
  TResult,
  TQueue extends string | undefined
>(
  rawBody: string | ArrayBuffer | ArrayBufferView,
  handler: HandlerDefinition<TName, TPayload, TResult, TQueue>,
  options?: WebhookVerificationOptions
): Promise<WebhookEvent<TResult>>;

/**
 * Verifies (when a secret is supplied), parses, and returns a webhook event.
 *
 * @param rawBody - Exact request body bytes.
 * @param options - HMAC secret, signature header, and optional result type.
 * @returns The typed webhook event.
 * @throws {VeyraWebhookError} When the signature is missing/invalid or the body is not JSON.
 */
export async function parseWebhook<TResult = unknown>(
  rawBody: string | ArrayBuffer | ArrayBufferView,
  options?: WebhookVerificationOptions
): Promise<WebhookEvent<TResult>>;

export async function parseWebhook(
  rawBody: string | ArrayBuffer | ArrayBufferView,
  handlerOrOptions?: HandlerDefinition | WebhookVerificationOptions,
  maybeOptions?: WebhookVerificationOptions
): Promise<WebhookEvent<unknown>> {
  const handler = isHandlerDefinition(handlerOrOptions)
    ? handlerOrOptions
    : undefined;
  const options: WebhookVerificationOptions =
    (handler
      ? maybeOptions
      : (handlerOrOptions as WebhookVerificationOptions | undefined)) ?? {};

  if (options.secret) {
    const valid = await verifyWebhookSignature(
      rawBody,
      options.signature,
      options.secret
    );
    if (!valid) {
      throw new VeyraWebhookError(
        'parseWebhook: invalid or missing X-Veyra-Signature header'
      );
    }
  }

  const bytes = toBytes(rawBody);
  const text = new TextDecoder().decode(bytes);
  let event: WebhookEvent<unknown>;
  try {
    event = JSON.parse(text) as WebhookEvent<unknown>;
  } catch (err) {
    throw new VeyraWebhookError(
      `parseWebhook: invalid JSON body: ${(err as Error).message}`,
      { cause: err }
    );
  }

  if (!event || typeof event !== 'object' || event.event !== 'job.completed') {
    throw new VeyraWebhookError(
      "parseWebhook: unexpected webhook payload structure (expected event='job.completed')"
    );
  }

  if (handler?.result && event.result !== null && event.result !== undefined) {
    event.result = await validateWithSchema(
      handler.result,
      event.result,
      `webhook('${handler.name}') result`
    );
  }

  return event;
}
