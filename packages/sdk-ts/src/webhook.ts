/**
 * Typed completion webhooks: signature verification and payload parsing.
 */

import { VeyraError } from './errors.js';
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

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const subtle =
    globalThis.crypto?.subtle ??
    (await import('node:crypto').catch(() => undefined))?.webcrypto?.subtle;
  if (!subtle) {
    throw new VeyraError(
      'Webhook signatures require the Web Crypto API (globalThis.crypto.subtle).'
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

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifies the `X-Veyra-Signature` header: `sha256=<hex HMAC-SHA256(rawBody)>`.
 *
 * @param rawBody - Exact request body bytes (do not re-serialize JSON).
 * @param signature - `X-Veyra-Signature` header value.
 * @param secret - Shared secret configured on the API.
 * @returns `true` when the signature matches.
 *
 * @example
 * ```ts
 * const ok = await verifyWebhookSignature(rawBody, req.headers['x-veyra-signature'], secret);
 * ```
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signature) {
    return false;
  }
  const separator = signature.indexOf('=');
  if (separator === -1 || signature.slice(0, separator) !== 'sha256') {
    return false;
  }
  const provided = signature.slice(separator + 1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) {
    return false;
  }
  const expected = toHex(await hmacSha256(secret, toBytes(rawBody)));
  return timingSafeEqualHex(expected, provided);
}

/**
 * Verifies (when a secret is supplied), parses, and optionally validates a
 * completion webhook.
 *
 * @param rawBody - Exact request body bytes.
 * @param handler - Optional definition whose result schema validates `event.result`.
 * @param options - HMAC secret and signature header.
 * @returns The typed webhook event.
 * @throws {VeyraError} When the signature is missing/invalid or the body is not JSON.
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
  rawBody: string | Uint8Array,
  handler: HandlerDefinition<TName, TPayload, TResult, TQueue>,
  options?: WebhookVerificationOptions
): Promise<WebhookEvent<TResult>>;

/**
 * Verifies (when a secret is supplied), parses, and returns a webhook event.
 *
 * @param rawBody - Exact request body bytes.
 * @param options - HMAC secret, signature header, and optional result type.
 * @returns The typed webhook event.
 * @throws {VeyraError} When the signature is missing/invalid or the body is not JSON.
 */
export async function parseWebhook<TResult = unknown>(
  rawBody: string | Uint8Array,
  options?: WebhookVerificationOptions
): Promise<WebhookEvent<TResult>>;

export async function parseWebhook(
  rawBody: string | Uint8Array,
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
      throw new VeyraError(
        'parseWebhook: invalid or missing X-Veyra-Signature'
      );
    }
  }

  const text =
    typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  let event: WebhookEvent<unknown>;
  try {
    event = JSON.parse(text) as WebhookEvent<unknown>;
  } catch (err) {
    throw new VeyraError(
      `parseWebhook: invalid JSON body: ${(err as Error).message}`
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
