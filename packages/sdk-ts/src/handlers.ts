/**
 * Handler contracts: built-in platform handlers, custom handler definitions,
 * and the generic handler map used to type `VeyraClient` and `VeyraWorker`.
 */

import { VeyraError } from './errors.js';
import type { SchemaLike } from './standard-schema.js';
import type { JsonValue } from './types.js';

/** Payload accepted by the built-in `http_request` handler. */
export interface HttpRequestPayload {
  /** Absolute URL to call. Required. */
  url: string;
  /** HTTP method. Defaults to `POST`. */
  method?: string;
  /** Headers applied verbatim to the outbound request. */
  headers?: Record<string, string>;
  /**
   * Request body. Strings are sent as-is; objects, arrays, numbers, and
   * booleans are JSON-encoded by the worker.
   */
  body?: JsonValue;
  /** Per-request timeout in seconds. Defaults to `30`, capped at `300`. */
  timeoutSeconds?: number;
}

/** Result recorded for a successful `http_request` job (2xx response). */
export interface HttpRequestResult {
  /** Upstream HTTP status code. */
  statusCode: number;
  /** Wall-clock request duration in milliseconds. */
  durationMs: number;
  /** Upstream `Content-Type` header, or an empty string. */
  contentType: string;
  /** First 2 KiB of the upstream response body. */
  responseExcerpt: string;
}

/** Payload accepted by the built-in `send_email` handler. */
export interface SendEmailPayload {
  /** One address or a list of addresses. */
  to: string | string[];
  /** Sender address. Falls back to the worker's `VEYRA_SMTP_FROM`. */
  from?: string;
  /** Subject line. Required. */
  subject: string;
  /** Plain-text body. At least one of `text` or `html` is required. */
  text?: string;
  /** HTML body. At least one of `text` or `html` is required. */
  html?: string;
  /** Carbon-copy recipients. */
  cc?: string | string[];
  /** Blind carbon-copy recipients. */
  bcc?: string | string[];
  /** Reply-To address. */
  replyTo?: string;
  /** Extra MIME headers. A caller-supplied `Message-ID` wins. */
  headers?: Record<string, string>;
}

/** Result recorded for a successful `send_email` job. */
export interface SendEmailResult {
  /** Message-ID used for delivery, without angle brackets. */
  messageId: string;
  /** Recipients the message was sent to. */
  to: string[];
  /** SMTP send duration in milliseconds. */
  durationMs: number;
}

/** The built-in `noop` handler ignores its payload. */
export type NoopPayload = unknown;

/** Result recorded for a successful `noop` job. */
export interface NoopResult {
  /** Always `true`; marks the result as synthetic. */
  simulated: boolean;
  /** Time spent in the handler, in milliseconds. */
  durationMs: number;
}

/**
 * Handlers shipped with the Veyra Go worker. Each entry maps a handler name to
 * its payload and result types.
 */
export interface BuiltInHandlers {
  http_request: { payload: HttpRequestPayload; result: HttpRequestResult };
  send_email: { payload: SendEmailPayload; result: SendEmailResult };
  noop: { payload: NoopPayload; result: NoopResult };
}

/** Shape of one handler entry in a {@link HandlerMap}. */
export interface HandlerContract<TPayload = unknown, TResult = unknown> {
  payload: TPayload;
  result: TResult;
}

/** A map of handler name to payload/result contract. */
export type HandlerMap = Record<string, HandlerContract<any, any>>;

/**
 * A reusable handler definition carrying its name, optional default queue,
 * and optional Standard Schemas for payload and result.
 */
export interface HandlerDefinition<
  TName extends string = string,
  TPayload = unknown,
  TResult = unknown,
  TQueue extends string | undefined = string | undefined
> {
  /** Handler name matched by the Veyra API and worker. */
  readonly name: TName;
  /** Default queue used by `client.enqueue(definition, payload)`. */
  readonly queue?: TQueue;
  /** Optional payload schema: validated on enqueue and before execution. */
  readonly payload?: SchemaLike<TPayload>;
  /** Optional result schema: validated after execution and on retrieval. */
  readonly result?: SchemaLike<TResult>;
  /** @internal Phantom type carrier. Never set at runtime. */
  readonly __types?: { readonly payload: TPayload; readonly result: TResult };
}

/** Configuration accepted by {@link defineHandler}. */
export interface HandlerConfig<
  TName extends string,
  TPayload,
  TResult,
  TQueue extends string | undefined
> {
  /** Handler name matched by the Veyra API and worker. */
  name: TName;
  /** Default queue used when enqueueing with this definition. */
  queue?: TQueue;
  /** Optional Standard Schema (or {@link staticSchema}) for the payload. */
  payload?: SchemaLike<TPayload>;
  /** Optional Standard Schema (or {@link staticSchema}) for the result. */
  result?: SchemaLike<TResult>;
}

/**
 * Defines a typed handler once and reuse it on producers, workers, and
 * webhook consumers.
 *
 * Payload and result types are inferred from the supplied schemas. Use explicit
 * generics when you only need types: `defineHandler<Payload, Result>({ name })`.
 *
 * @example
 * ```ts
 * const sendEmail = defineHandler({
 *   name: 'send_email',
 *   queue: 'emails',
 *   payload: z.object({ to: z.string(), subject: z.string() }),
 *   result: z.object({ messageId: z.string() }),
 * });
 * ```
 *
 * @throws {VeyraError} When `name` is empty.
 */
export function defineHandler<
  TPayload = unknown,
  TResult = unknown,
  const TName extends string = string,
  const TQueue extends string | undefined = undefined
>(
  config: HandlerConfig<TName, TPayload, TResult, TQueue>
): HandlerDefinition<TName, TPayload, TResult, TQueue> {
  if (typeof config.name !== 'string' || config.name.trim() === '') {
    throw new VeyraError('defineHandler: name must not be empty');
  }
  return {
    name: config.name.trim() as TName,
    queue: config.queue,
    payload: config.payload,
    result: config.result,
  };
}

/** Built-ins plus user handlers, with user definitions winning on collisions. */
export type ResolvedHandlers<THandlers extends object> = Omit<
  BuiltInHandlers,
  keyof THandlers
> &
  THandlers;

/** String keys of a handler map. */
export type HandlerName<THandlers extends object> = Extract<keyof THandlers, string>;

/** Payload type of a named handler. */
export type HandlerPayload<
  THandlers extends object,
  TName extends HandlerName<THandlers>
> = THandlers[TName] extends HandlerContract<infer TPayload, any> ? TPayload : unknown;

/** Result type of a named handler. */
export type HandlerResult<
  THandlers extends object,
  TName extends HandlerName<THandlers>
> = THandlers[TName] extends HandlerContract<any, infer TResult> ? TResult : unknown;

/** Payload type of a known handler, or a fallback for arbitrary names. */
export type HandlerPayloadFor<
  THandlers extends object,
  TName extends string,
  TFallback = unknown
> = TName extends HandlerName<THandlers> ? HandlerPayload<THandlers, TName> : TFallback;

/** Result type of a known handler, or a fallback for arbitrary names. */
export type HandlerResultFor<
  THandlers extends object,
  TName extends string,
  TFallback = unknown
> = TName extends HandlerName<THandlers> ? HandlerResult<THandlers, TName> : TFallback;

/** Payload type carried by a {@link HandlerDefinition}. */
export type DefinitionPayload<TDefinition> =
  TDefinition extends HandlerDefinition<any, infer TPayload, any, any> ? TPayload : unknown;

/** Result type carried by a {@link HandlerDefinition}. */
export type DefinitionResult<TDefinition> =
  TDefinition extends HandlerDefinition<any, any, infer TResult, any> ? TResult : unknown;

/** Returns `true` for a {@link HandlerDefinition} (and not an enqueue input). */
export function isHandlerDefinition(value: unknown): value is HandlerDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    !('handler' in value)
  );
}
