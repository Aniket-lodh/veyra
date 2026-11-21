/**
 * Veyra HTTP client.
 */

import {
  LeaseLostError,
  VeyraApiError,
  VeyraAuthError,
  VeyraConflictError,
  VeyraError,
  VeyraNetworkError,
  VeyraNotFoundError,
  VeyraRateLimitError,
  VeyraTimeoutError,
  VeyraValidationError,
} from './errors.js';
import { isHandlerDefinition } from './handlers.js';
import type {
  BuiltInHandlers,
  DefinitionPayload,
  DefinitionResult,
  HandlerDefinition,
  HandlerName,
  HandlerPayload,
  HandlerResult,
  ResolvedHandlers,
} from './handlers.js';
import { validateWithSchema } from './standard-schema.js';
import type {
  ClaimParams,
  CompleteJobResponse,
  DefinitionEnqueueInput,
  DeregisterWorkerResponse,
  EnqueueJobInput,
  EnqueueOptions,
  FailJobParams,
  FailJobResponse,
  HeartbeatResponse,
  Job,
  JobClaim,
  RenewLeaseResponse,
  RequestOptions,
  TypedEnqueueInput,
  TypedEnqueuePayload,
  TypedEnqueueResult,
  VeyraClientConfig,
  VeyraLogger,
  VeyraWorkerOptions,
  WorkerRecord,
  WorkerRegisterParams,
} from './types.js';
import { VeyraWorker } from './worker.js';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new VeyraError('Operation was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new VeyraError('Operation was aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertJsonSerializable(value: unknown, label: string): void {
  if (value === undefined) {
    throw new VeyraValidationError(label, [{ message: `${label} is required` }]);
  }
  try {
    JSON.stringify(value);
  } catch (err) {
    throw new VeyraValidationError(
      label,
      [{ message: `${label} must be JSON-serializable: ${(err as Error).message}` }],
      { cause: err }
    );
  }
}

function validateSafeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VeyraValidationError(name, [{ message: `${name} is required and must be a non-empty string` }]);
  }
  const trimmed = value.trim();
  if (/[\r\n\t\x00-\x1F\x7F]/.test(trimmed)) {
    throw new VeyraValidationError(name, [{ message: `${name} contains invalid control characters` }]);
  }
  return trimmed;
}

function validateCallbackUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 2048) {
    throw new VeyraValidationError('callbackUrl', [{ message: 'callbackUrl must be at most 2048 characters' }]);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new VeyraValidationError('callbackUrl', [{ message: `callbackUrl is not a valid URL: ${(err as Error).message}` }]);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VeyraValidationError('callbackUrl', [{ message: "callbackUrl scheme must be 'http:' or 'https:'" }]);
  }
  if (!parsed.host) {
    throw new VeyraValidationError('callbackUrl', [{ message: 'callbackUrl must include a valid host' }]);
  }
  return trimmed;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

function sanitizeHeader(name: string, value: string): void {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
    throw new VeyraValidationError('headers', [
      { message: `Header '${name}' contains invalid newline characters (CRLF)` },
    ]);
  }
}

/**
 * Typed client for the Veyra REST API.
 *
 * @typeParam THandlers - Extra handler contracts merged over {@link BuiltInHandlers}.
 * Register handlers here to get autocomplete and payload/result checking on
 * string-based `enqueue` calls shared across services.
 *
 * @example
 * ```ts
 * interface MyHandlers {
 *   send_email: { payload: { to: string }; result: { messageId: string } };
 * }
 * const client = new VeyraClient<MyHandlers>({ baseUrl, apiKey });
 * const job = await client.enqueue({ handler: 'send_email', payload: { to: 'a@b.c' } });
 * job.result?.messageId; // string
 * ```
 */
export class VeyraClient<THandlers extends object = BuiltInHandlers> {
  /** API origin without a trailing slash. */
  readonly baseUrl: string;
  /** Queue used when `enqueue` omits `queue`. */
  readonly defaultQueue: string;

  /** @internal Credentials are held in private state to prevent accidental leakage via inspect/JSON/keys. */
  readonly #apiKey: string;
  readonly #customFetch?: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #logger?: VeyraLogger;

  /**
   * @param config - API origin, API key, and transport settings.
   * @throws {VeyraValidationError} When `baseUrl` or `apiKey` is invalid.
   */
  constructor(config: VeyraClientConfig) {
    if (!config || typeof config !== 'object') {
      throw new VeyraValidationError('config', [{ message: 'VeyraClientConfig must be an object' }]);
    }

    if (!config.baseUrl || typeof config.baseUrl !== 'string') {
      throw new VeyraValidationError('baseUrl', [{ message: 'baseUrl is required and must be a string' }]);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.baseUrl);
    } catch (err) {
      throw new VeyraValidationError('baseUrl', [
        { message: `baseUrl '${config.baseUrl}' is not a valid URL: ${(err as Error).message}` },
      ]);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new VeyraValidationError('baseUrl', [
        { message: `baseUrl must use http: or https: protocol (received '${parsedUrl.protocol}')` },
      ]);
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');

    if (!config.apiKey || typeof config.apiKey !== 'string') {
      throw new VeyraValidationError('apiKey', [{ message: 'apiKey is required and must be a non-empty string' }]);
    }
    const trimmedKey = config.apiKey.trim();
    if (!trimmedKey) {
      throw new VeyraValidationError('apiKey', [{ message: 'apiKey must not be empty or whitespace' }]);
    }
    if (/[\r\n\t\x00-\x1F\x7F]/.test(trimmedKey)) {
      throw new VeyraValidationError('apiKey', [{ message: 'apiKey contains invalid control characters' }]);
    }
    this.#apiKey = trimmedKey;

    if (config.timeoutMs !== undefined) {
      if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
        throw new VeyraValidationError('timeoutMs', [{ message: 'timeoutMs must be a positive finite number' }]);
      }
    }
    this.#defaultTimeoutMs = config.timeoutMs ?? 30_000;

    if (config.maxRetries !== undefined) {
      if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10) {
        throw new VeyraValidationError('maxRetries', [{ message: 'maxRetries must be an integer between 0 and 10' }]);
      }
    }
    this.#maxRetries = config.maxRetries ?? 2;

    if (config.defaultQueue !== undefined) {
      if (typeof config.defaultQueue !== 'string' || !config.defaultQueue.trim()) {
        throw new VeyraValidationError('defaultQueue', [{ message: 'defaultQueue must be a non-empty string' }]);
      }
    }
    this.defaultQueue = config.defaultQueue?.trim() || 'default';
    this.#customFetch = config.fetch;
    this.#logger = config.logger;
  }

  /**
   * Safe JSON representation redacting all sensitive credentials.
   */
  toJSON(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      defaultQueue: this.defaultQueue,
      hasApiKey: true,
    };
  }

  /**
   * Node.js custom inspection hook redacting all sensitive credentials from console output.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Enqueues a job from a {@link HandlerDefinition}. The payload is validated
   * against the definition's schema before the request is sent.
   *
   * @param handler - Definition created with `defineHandler`.
   * @param payload - Payload matching the definition.
   * @param options - Per-call overrides. `options.queue` wins over the definition's queue.
   * @returns The created (or idempotently replayed) job.
   * @throws {VeyraValidationError} When the payload fails schema validation or inputs are invalid.
   *
   * @example
   * ```ts
   * await client.enqueue(sendEmail, { to: 'a@b.c', subject: 'Hi' });
   * ```
   */
  async enqueue<
    TName extends string,
    TPayload,
    TResult,
    TQueue extends string | undefined
  >(
    handler: HandlerDefinition<TName, TPayload, TResult, TQueue>,
    payload: TPayload,
    options?: EnqueueOptions
  ): Promise<Job<TPayload, TResult>>;

  /**
   * Enqueues a job using an object containing a {@link HandlerDefinition}.
   * The payload is validated against the definition's schema before sending.
   *
   * @param input - Definition handler, payload, and optional enqueue options.
   * @returns The created (or idempotently replayed) job.
   * @throws {VeyraValidationError} When the payload fails schema validation or inputs are invalid.
   *
   * @example
   * ```ts
   * await client.enqueue({ handler: sendEmail, payload: { to: 'a@b.c', subject: 'Hi' } });
   * ```
   */
  async enqueue<
    TDefinition extends HandlerDefinition<any, any, any, any>
  >(
    input: DefinitionEnqueueInput<TDefinition>
  ): Promise<Job<DefinitionPayload<TDefinition>, DefinitionResult<TDefinition>>>;

  /**
   * Enqueues a job using the object form.
   *
   * Known handler names (built-ins plus `THandlers`) autocomplete and constrain
   * `payload` and type `result`; unknown string names fall back to the supplied generics.
   *
   * @param input - Handler name, payload, and optional enqueue options.
   * @returns The created (or idempotently replayed) job.
   * @throws {VeyraApiError} When the API rejects the request.
   *
   * @example
   * ```ts
   * await client.enqueue({ handler: 'http_request', payload: { url: 'https://example.com' } });
   * ```
   */
  async enqueue<
    TPayload = unknown,
    TResult = unknown,
    const TName extends HandlerName<ResolvedHandlers<THandlers>> | (string & {}) =
      | HandlerName<ResolvedHandlers<THandlers>>
      | (string & {})
  >(
    input: TypedEnqueueInput<ResolvedHandlers<THandlers>, TName, TPayload>
  ): Promise<
    Job<
      TypedEnqueuePayload<ResolvedHandlers<THandlers>, TName, TPayload>,
      TypedEnqueueResult<ResolvedHandlers<THandlers>, TName, TResult>
    >
  >;

  async enqueue(
    inputOrHandler: EnqueueJobInput | DefinitionEnqueueInput<any> | HandlerDefinition,
    payload?: unknown,
    options?: EnqueueOptions
  ): Promise<Job> {
    let input: EnqueueJobInput;
    let signal: AbortSignal | undefined;
    let retries: number | undefined;

    if (isHandlerDefinition(inputOrHandler)) {
      const definition = inputOrHandler;
      const validated = await validateWithSchema(
        definition.payload,
        payload,
        `enqueue('${definition.name}') payload`
      );
      input = { ...(options ?? {}), handler: definition.name, payload: validated };
      if (input.queue === undefined && definition.queue !== undefined) {
        input.queue = definition.queue;
      }
      signal = options?.signal;
      retries = options?.retries;
    } else if (
      typeof inputOrHandler === 'object' &&
      inputOrHandler !== null &&
      'handler' in inputOrHandler &&
      isHandlerDefinition((inputOrHandler as { handler?: unknown }).handler)
    ) {
      const defInput = inputOrHandler as unknown as DefinitionEnqueueInput<any>;
      const definition = defInput.handler;
      const validated = await validateWithSchema(
        definition.payload,
        defInput.payload,
        `enqueue('${definition.name}') payload`
      );
      const { handler: _ignored, ...rest } = defInput;
      input = { ...rest, handler: definition.name, payload: validated };
      if (input.queue === undefined && definition.queue !== undefined) {
        input.queue = definition.queue;
      }
      signal = defInput.signal;
      retries = defInput.retries;
    } else {
      input = inputOrHandler as EnqueueJobInput;
      signal = input.signal;
      retries = input.retries;
    }

    const handler = validateSafeIdentifier(input.handler, 'handler');
    const queue = input.queue !== undefined
      ? validateSafeIdentifier(input.queue, 'queue')
      : this.defaultQueue;

    assertJsonSerializable(input.payload, `enqueue('${handler}') payload`);

    const body: Record<string, unknown> = {
      handler,
      queue,
      payload: input.payload,
    };

    if (input.priority !== undefined) {
      if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 9) {
        throw new VeyraValidationError('priority', [{ message: 'priority must be an integer between 0 and 9' }]);
      }
      body.priority = input.priority;
    }

    if (input.maxAttempts !== undefined) {
      if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
        throw new VeyraValidationError('maxAttempts', [{ message: 'maxAttempts must be an integer >= 1' }]);
      }
      body.maxAttempts = input.maxAttempts;
    }

    if (input.backoff !== undefined) {
      if (!input.backoff || typeof input.backoff !== 'object' || !input.backoff.kind) {
        throw new VeyraValidationError('backoff', [{ message: 'backoff must specify kind' }]);
      }
      body.backoff = input.backoff;
    }

    if (input.scheduledFor !== undefined) {
      if (input.scheduledFor instanceof Date) {
        body.scheduledFor = input.scheduledFor.toISOString();
      } else if (typeof input.scheduledFor === 'string' && input.scheduledFor.trim() !== '') {
        body.scheduledFor = input.scheduledFor.trim();
      } else {
        throw new VeyraValidationError('scheduledFor', [{ message: 'scheduledFor must be an ISO string or Date' }]);
      }
    }

    const headers: Record<string, string> = {};
    if (input.idempotencyKey !== undefined) {
      const key = validateSafeIdentifier(input.idempotencyKey, 'idempotencyKey');
      body.idempotencyKey = key;
      headers['Idempotency-Key'] = key;
    }

    if (input.callbackUrl !== undefined) {
      body.callbackUrl = validateCallbackUrl(input.callbackUrl);
    }

    const isIdempotent = Boolean(body.idempotencyKey);
    const { data, headers: resHeaders } = await this.#request<Job>('/jobs', {
      method: 'POST',
      headers,
      body,
      signal,
      idempotent: isIdempotent,
      retries,
    });

    if (resHeaders.get('idempotent-replay') === 'true') {
      data.isReplay = true;
    }

    return data;
  }

  /**
   * Fetches a job and validates its result with the definition's schema.
   *
   * @param jobId - Job ULID.
   * @param handler - Definition whose result schema should validate `job.result`.
   * @param options - Request cancellation and retry options.
   * @returns The job with `result` typed as the definition's result.
   */
  async getJob<
    TName extends string,
    TPayload,
    TResult,
    TQueue extends string | undefined
  >(
    jobId: string,
    handler: HandlerDefinition<TName, TPayload, TResult, TQueue>,
    options?: RequestOptions
  ): Promise<Job<TPayload, TResult>>;

  /**
   * Fetches a job for a known built-in or registered handler name.
   *
   * @param jobId - Job ULID.
   * @param handler - Known handler name string.
   * @param options - Request cancellation and retry options.
   * @returns The job with `payload` and `result` typed according to the handler contract.
   */
  async getJob<const TName extends HandlerName<ResolvedHandlers<THandlers>>>(
    jobId: string,
    handler: TName,
    options?: RequestOptions
  ): Promise<
    Job<
      HandlerPayload<ResolvedHandlers<THandlers>, TName>,
      HandlerResult<ResolvedHandlers<THandlers>, TName>
    >
  >;

  /**
   * Fetches a job with only the result type specified.
   *
   * @param jobId - Job ULID.
   * @param options - Request cancellation and retry options.
   * @returns The job with `result` typed as `TResult`.
   */
  async getJob<TResult = unknown>(
    jobId: string,
    options?: RequestOptions
  ): Promise<Job<unknown, TResult>>;

  /** @deprecated Prefer `getJob<TResult>(jobId)` or `getJob(jobId, handler)`. */
  async getJob<TPayload = unknown, TResult = unknown>(
    jobId: string,
    options?: RequestOptions
  ): Promise<Job<TPayload, TResult>>;

  async getJob(
    jobId: string,
    handlerOrOptions?: HandlerDefinition | string | RequestOptions,
    maybeOptions?: RequestOptions
  ): Promise<Job> {
    const validId = validateSafeIdentifier(jobId, 'jobId');
    const handler =
      isHandlerDefinition(handlerOrOptions) || typeof handlerOrOptions === 'string'
        ? handlerOrOptions
        : undefined;
    const options: RequestOptions | undefined = handler
      ? maybeOptions
      : (handlerOrOptions as RequestOptions | undefined);

    const { data } = await this.#request<Job>(
      `/jobs/${encodeURIComponent(validId)}`,
      {
        method: 'GET',
        signal: options?.signal,
        idempotent: true,
        retries: options?.retries,
      }
    );

    if (isHandlerDefinition(handler) && handler.result && data.result !== null) {
      data.result = await validateWithSchema(
        handler.result,
        data.result,
        `getJob('${handler.name}') result`
      );
    }
    return data;
  }

  /**
   * Cancels a queued, scheduled, failed, or running job.
   *
   * @param jobId - Job ULID.
   * @param options - Request cancellation and retry options.
   * @returns The cancelled job.
   * @throws {VeyraConflictError} When the job already succeeded or was dead-lettered.
   */
  async cancelJob(jobId: string, options?: RequestOptions): Promise<Job> {
    const validId = validateSafeIdentifier(jobId, 'jobId');
    const { data } = await this.#request<Job>(
      `/jobs/${encodeURIComponent(validId)}/cancel`,
      {
        method: 'POST',
        signal: options?.signal,
        idempotent: true,
        retries: options?.retries,
      }
    );
    return data;
  }

  /**
   * Retries a failed, cancelled, or dead-lettered job.
   *
   * @param jobId - Job ULID.
   * @param options - Request cancellation and retry options.
   * @returns The retried job.
   * @throws {VeyraConflictError} When the job is not in a retryable state.
   */
  async retryJob(jobId: string, options?: RequestOptions): Promise<Job> {
    const validId = validateSafeIdentifier(jobId, 'jobId');
    const { data } = await this.#request<Job>(
      `/jobs/${encodeURIComponent(validId)}/retry`,
      {
        method: 'POST',
        signal: options?.signal,
        idempotent: true,
        retries: options?.retries,
      }
    );
    return data;
  }

  /**
   * Registers a worker with the cluster.
   *
   * @param params - Identity, queues, handlers, and concurrency.
   * @returns The stored worker record.
   */
  async registerWorker(params: WorkerRegisterParams): Promise<WorkerRecord> {
    const { data } = await this.#request<WorkerRecord>('/workers/register', {
      method: 'POST',
      body: params,
      idempotent: true,
    });
    return data;
  }

  /**
   * Sends a worker-level heartbeat.
   *
   * @param workerId - Worker id.
   * @returns The worker's current state and heartbeat timestamp.
   * @throws {VeyraNotFoundError} When the worker no longer exists.
   */
  async heartbeatWorker(workerId: string): Promise<HeartbeatResponse> {
    const validId = validateSafeIdentifier(workerId, 'workerId');
    const { data } = await this.#request<HeartbeatResponse>(
      `/workers/${encodeURIComponent(validId)}/heartbeat`,
      { method: 'POST', idempotent: true }
    );
    return data;
  }

  /**
   * Claims the next runnable job for a worker.
   *
   * @param workerId - Worker id.
   * @param params - Optional queue/handler filter.
   * @returns The claimed job, or `null` on `204 No Content`.
   */
  async claimJob<TPayload = unknown>(
    workerId: string,
    params?: ClaimParams
  ): Promise<JobClaim<TPayload> | null> {
    const validId = validateSafeIdentifier(workerId, 'workerId');
    const { data, status } = await this.#request<JobClaim<TPayload> | null>(
      `/workers/${encodeURIComponent(validId)}/claim`,
      {
        method: 'POST',
        body: params || {},
        idempotent: false,
      }
    );

    if (status === 204 || !data) {
      return null;
    }
    return data;
  }

  /**
   * Renews the lease for an in-flight job.
   *
   * @param workerId - Worker id.
   * @param jobId - Job ULID.
   * @returns The renewed lease.
   * @throws {LeaseLostError} When the lease expired or was reassigned.
   */
  async renewJobLease(
    workerId: string,
    jobId: string
  ): Promise<RenewLeaseResponse> {
    const validWorkerId = validateSafeIdentifier(workerId, 'workerId');
    const validJobId = validateSafeIdentifier(jobId, 'jobId');
    const { data } = await this.#request<RenewLeaseResponse>(
      `/workers/${encodeURIComponent(validWorkerId)}/jobs/${encodeURIComponent(
        validJobId
      )}/heartbeat`,
      { method: 'POST', idempotent: true }
    );
    return data;
  }

  /**
   * Marks a job as completed with an optional result payload.
   *
   * @param workerId - Worker id.
   * @param jobId - Job ULID.
   * @param result - JSON result recorded on the job.
   * @returns The completion acknowledgement.
   * @throws {LeaseLostError} When the lease expired or was reassigned.
   */
  async completeJob(
    workerId: string,
    jobId: string,
    result?: unknown
  ): Promise<CompleteJobResponse> {
    const validWorkerId = validateSafeIdentifier(workerId, 'workerId');
    const validJobId = validateSafeIdentifier(jobId, 'jobId');
    const body: Record<string, unknown> = {};
    if (result !== undefined) {
      assertJsonSerializable(result, `completeJob('${jobId}') result`);
      body.result = result;
    }

    const { data } = await this.#request<CompleteJobResponse>(
      `/workers/${encodeURIComponent(validWorkerId)}/jobs/${encodeURIComponent(
        validJobId
      )}/complete`,
      {
        method: 'POST',
        body,
        idempotent: false,
      }
    );
    return data;
  }

  /**
   * Reports a job execution failure.
   *
   * @param workerId - Worker id.
   * @param jobId - Job ULID.
   * @param params - Error class, message, stack trace, and permanence.
   * @returns The failure acknowledgement.
   */
  async failJob(
    workerId: string,
    jobId: string,
    params: FailJobParams
  ): Promise<FailJobResponse> {
    const validWorkerId = validateSafeIdentifier(workerId, 'workerId');
    const validJobId = validateSafeIdentifier(jobId, 'jobId');
    const { data } = await this.#request<FailJobResponse>(
      `/workers/${encodeURIComponent(validWorkerId)}/jobs/${encodeURIComponent(
        validJobId
      )}/fail`,
      {
        method: 'POST',
        body: params,
        idempotent: false,
      }
    );
    return data;
  }

  /**
   * Transitions a worker to `draining` so it stops claiming new jobs.
   *
   * @param workerId - Worker id.
   * @returns The updated worker record.
   */
  async drainWorker(workerId: string): Promise<WorkerRecord> {
    const validId = validateSafeIdentifier(workerId, 'workerId');
    const { data } = await this.#request<WorkerRecord>(
      `/workers/${encodeURIComponent(validId)}/drain`,
      { method: 'POST', idempotent: true }
    );
    return data;
  }

  /**
   * Deregisters a worker from the active fleet.
   *
   * @param workerId - Worker id.
   * @returns The deregistration acknowledgement.
   * @throws {VeyraConflictError} When the worker still holds active leases.
   */
  async deregisterWorker(workerId: string): Promise<DeregisterWorkerResponse> {
    const validId = validateSafeIdentifier(workerId, 'workerId');
    const { data } = await this.#request<DeregisterWorkerResponse>(
      `/workers/${encodeURIComponent(validId)}/deregister`,
      { method: 'POST', idempotent: true }
    );
    return data;
  }

  /**
   * Creates a managed {@link VeyraWorker} bound to this client.
   *
   * @param options - Queues, concurrency, and lifecycle callbacks.
   * @returns A worker that inherits this client's handler map.
   */
  createWorker(options: VeyraWorkerOptions): VeyraWorker<THandlers> {
    return new VeyraWorker<THandlers>(this, options);
  }

  /**
   * Internal HTTP transport method with timeout, cancellation, credential encapsulation,
   * safe non-JSON error handling, and exponential backoff retry for idempotent calls.
   */
  async #request<T>(
    path: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
      idempotent?: boolean;
      retries?: number;
    }
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const fetchImpl = this.#customFetch || globalThis.fetch;
    if (!fetchImpl) {
      throw new VeyraError(
        'No fetch implementation available. Node 18+ or a global fetch polyfill is required.'
      );
    }

    const url = `${this.baseUrl}${path}`;
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
    };

    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        sanitizeHeader(k, v);
        baseHeaders[k] = v;
      }
    }

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      baseHeaders['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const maxAttempts = options.idempotent
      ? 1 + (options.retries !== undefined ? Math.max(0, options.retries) : this.#maxRetries)
      : 1;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new VeyraError('Operation was aborted');
      }

      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(
          new VeyraTimeoutError(
            `Request timed out after ${this.#defaultTimeoutMs}ms: ${url}`,
            this.#defaultTimeoutMs
          )
        );
      }, this.#defaultTimeoutMs);

      function onUserAbort() {
        controller.abort(options.signal?.reason);
      }
      if (options.signal) {
        options.signal.addEventListener('abort', onUserAbort, { once: true });
      }

      try {
        const res = await fetchImpl(url, {
          method: options.method,
          headers: baseHeaders,
          body: bodyStr,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', onUserAbort);

        const requestId = res.headers.get('x-request-id') ?? undefined;

        if (res.status === 204) {
          return { data: undefined as unknown as T, status: 204, headers: res.headers };
        }

        const text = await res.text();
        let parsed: unknown;
        let isJson = false;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
            isJson = true;
          } catch {
            parsed = text;
          }
        }

        if (!res.ok) {
          let errorMessage: string;
          if (
            isJson &&
            typeof parsed === 'object' &&
            parsed !== null &&
            'error' in parsed &&
            typeof (parsed as { error: unknown }).error === 'string'
          ) {
            errorMessage = (parsed as { error: string }).error;
          } else if (
            text.startsWith('<!DOCTYPE') ||
            text.startsWith('<html') ||
            text.startsWith('<HTML')
          ) {
            errorMessage = `HTTP ${res.status} ${res.statusText || 'Error'}`;
          } else if (text.length > 0) {
            errorMessage = text.length > 256 ? `${text.slice(0, 256)}...` : text;
          } else {
            errorMessage = res.statusText || `HTTP ${res.status}`;
          }

          let errorToThrow: VeyraApiError;
          if (res.status === 401 || res.status === 403) {
            errorToThrow = new VeyraAuthError(res.status, res.statusText, errorMessage, parsed, { requestId });
          } else if (res.status === 404) {
            errorToThrow = new VeyraNotFoundError(res.status, res.statusText, errorMessage, parsed, { requestId });
          } else if (res.status === 409) {
            if (errorMessage.includes('lease') || errorMessage.includes('expired')) {
              errorToThrow = new LeaseLostError(errorMessage, { requestId });
            } else {
              errorToThrow = new VeyraConflictError(res.status, res.statusText, errorMessage, parsed, { requestId });
            }
          } else if (res.status === 429) {
            const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
            errorToThrow = new VeyraRateLimitError(res.status, res.statusText, errorMessage, parsed, {
              requestId,
              retryAfterMs,
            });
          } else {
            errorToThrow = new VeyraApiError(res.status, res.statusText, errorMessage, parsed, {
              requestId,
              retryable: res.status === 502 || res.status === 503 || res.status === 504,
            });
          }

          if (options.idempotent && errorToThrow.retryable && attempt < maxAttempts - 1) {
            lastError = errorToThrow;
            const backoffMs =
              errorToThrow instanceof VeyraRateLimitError && errorToThrow.retryAfterMs !== undefined
                ? Math.min(errorToThrow.retryAfterMs, 30_000)
                : Math.min(10_000, 150 * Math.pow(2, attempt)) + Math.random() * 100;
            this.#logger?.warn?.(`VeyraClient retryable error (${res.status}), retrying in ${Math.round(backoffMs)}ms`, {
              attempt: attempt + 1,
              status: res.status,
              requestId,
            });
            await sleep(backoffMs, options.signal);
            continue;
          }

          throw errorToThrow;
        }

        return { data: parsed as T, status: res.status, headers: res.headers };
      } catch (err) {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', onUserAbort);

        let finalError: unknown;
        if (timedOut || err instanceof VeyraTimeoutError) {
          finalError = new VeyraTimeoutError(
            `Request timed out after ${this.#defaultTimeoutMs}ms: ${url}`,
            this.#defaultTimeoutMs,
            { cause: err }
          );
        } else if (options.signal?.aborted) {
          finalError = options.signal.reason ?? err;
        } else if (err instanceof VeyraError) {
          finalError = err;
        } else {
          finalError = new VeyraNetworkError(
            `Network error while fetching ${url}: ${(err as Error).message}`,
            { cause: err }
          );
        }

        const isRetryable =
          options.idempotent &&
          (finalError instanceof VeyraNetworkError ||
            finalError instanceof VeyraTimeoutError ||
            (finalError instanceof VeyraApiError && finalError.retryable));

        if (isRetryable && attempt < maxAttempts - 1) {
          lastError = finalError;
          const backoffMs = Math.min(10_000, 150 * Math.pow(2, attempt)) + Math.random() * 100;
          this.#logger?.warn?.(`VeyraClient network error, retrying in ${Math.round(backoffMs)}ms`, {
            attempt: attempt + 1,
            error: (finalError as Error).message,
          });
          await sleep(backoffMs, options.signal);
          continue;
        }

        throw finalError;
      }
    }

    throw lastError;
  }
}
