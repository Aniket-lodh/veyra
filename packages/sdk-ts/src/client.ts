/**
 * Veyra HTTP client.
 */

import {
  LeaseLostError,
  VeyraApiError,
  VeyraAuthError,
  VeyraConflictError,
  VeyraError,
  VeyraNotFoundError,
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
  TypedEnqueueInput,
  TypedEnqueuePayload,
  TypedEnqueueResult,
  VeyraClientConfig,
  VeyraWorkerOptions,
  WorkerRecord,
  WorkerRegisterParams,
} from './types.js';
import { VeyraWorker } from './worker.js';

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
  /** Bearer API key. */
  readonly apiKey: string;
  /** Queue used when `enqueue` omits `queue`. */
  readonly defaultQueue: string;
  private readonly customFetch?: typeof fetch;
  private readonly defaultTimeoutMs: number;

  /**
   * @param config - API origin, API key, and optional transport settings.
   * @throws {VeyraError} When `baseUrl` or `apiKey` is missing.
   */
  constructor(config: VeyraClientConfig) {
    if (!config?.baseUrl) {
      throw new VeyraError('VeyraClient: baseUrl is required');
    }
    if (!config?.apiKey) {
      throw new VeyraError('VeyraClient: apiKey is required');
    }

    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey.trim();
    this.defaultQueue = config.defaultQueue?.trim() || 'default';
    this.customFetch = config.fetch;
    this.defaultTimeoutMs = config.timeoutMs ?? 30_000;
  }

  /**
   * Enqueues a job from a {@link HandlerDefinition}. The payload is validated
   * against the definition's schema before the request is sent.
   *
   * @param handler - Definition created with `defineHandler`.
   * @param payload - Payload matching the definition.
   * @param options - Per-call overrides. `options.queue` wins over the definition's queue.
   * @returns The created (or idempotently replayed) job.
   * @throws {VeyraValidationError} When the payload fails schema validation.
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
   * @throws {VeyraValidationError} When the payload fails schema validation.
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
    } else {
      input = inputOrHandler as EnqueueJobInput;
    }

    const queue = input.queue?.trim() || this.defaultQueue;
    const handler = input.handler?.trim();
    if (!handler) {
      throw new VeyraError('enqueue: handler name is required');
    }
    if (input.payload === undefined) {
      throw new VeyraError('enqueue: payload is required');
    }

    const body: Record<string, unknown> = {
      handler,
      queue,
      payload: input.payload,
    };

    if (input.priority !== undefined) {
      body.priority = input.priority;
    }
    if (input.maxAttempts !== undefined) {
      body.maxAttempts = input.maxAttempts;
    }
    if (input.backoff !== undefined) {
      body.backoff = input.backoff;
    }
    if (input.scheduledFor !== undefined) {
      body.scheduledFor = input.scheduledFor;
    }
    if (input.idempotencyKey !== undefined) {
      body.idempotencyKey = input.idempotencyKey.trim();
    }
    if (input.callbackUrl !== undefined) {
      body.callbackUrl = input.callbackUrl.trim();
    }

    const headers: Record<string, string> = {};
    if (input.idempotencyKey) {
      headers['Idempotency-Key'] = input.idempotencyKey.trim();
    }

    const { data, headers: resHeaders } = await this.request<Job>('/jobs', {
      method: 'POST',
      headers,
      body,
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
   * @returns The job with `result` typed as the definition's result.
   *
   * @example
   * ```ts
   * const job = await client.getJob(jobId, sendEmail);
   * ```
   */
  async getJob<
    TName extends string,
    TPayload,
    TResult,
    TQueue extends string | undefined
  >(
    jobId: string,
    handler: HandlerDefinition<TName, TPayload, TResult, TQueue>
  ): Promise<Job<TPayload, TResult>>;

  /**
   * Fetches a job for a known built-in or registered handler name.
   *
   * @param jobId - Job ULID.
   * @param handler - Known handler name string.
   * @returns The job with `payload` and `result` typed according to the handler contract.
   *
   * @example
   * ```ts
   * const job = await client.getJob(jobId, 'http_request');
   * job.result?.statusCode; // number | undefined
   * ```
   */
  async getJob<const TName extends HandlerName<ResolvedHandlers<THandlers>>>(
    jobId: string,
    handler: TName
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
   * @returns The job with `result` typed as `TResult`.
   */
  async getJob<TResult = unknown>(jobId: string): Promise<Job<unknown, TResult>>;

  /** @deprecated Prefer `getJob<TResult>(jobId)` or `getJob(jobId, handler)`. */
  async getJob<TPayload = unknown, TResult = unknown>(
    jobId: string
  ): Promise<Job<TPayload, TResult>>;

  async getJob(
    jobId: string,
    handler?: HandlerDefinition | string
  ): Promise<Job> {
    if (!jobId?.trim()) {
      throw new VeyraError('getJob: jobId is required');
    }
    const { data } = await this.request<Job>(
      `/jobs/${encodeURIComponent(jobId.trim())}`,
      { method: 'GET' }
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
   * @returns The cancelled job.
   * @throws {VeyraConflictError} When the job already succeeded or was dead-lettered.
   */
  async cancelJob(jobId: string): Promise<Job> {
    if (!jobId?.trim()) {
      throw new VeyraError('cancelJob: jobId is required');
    }
    const { data } = await this.request<Job>(
      `/jobs/${encodeURIComponent(jobId.trim())}/cancel`,
      { method: 'POST' }
    );
    return data;
  }

  /**
   * Retries a failed, cancelled, or dead-lettered job.
   *
   * @param jobId - Job ULID.
   * @returns The retried job.
   * @throws {VeyraConflictError} When the job is not in a retryable state.
   */
  async retryJob(jobId: string): Promise<Job> {
    if (!jobId?.trim()) {
      throw new VeyraError('retryJob: jobId is required');
    }
    const { data } = await this.request<Job>(
      `/jobs/${encodeURIComponent(jobId.trim())}/retry`,
      { method: 'POST' }
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
    const { data } = await this.request<WorkerRecord>('/workers/register', {
      method: 'POST',
      body: params,
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
    const { data } = await this.request<HeartbeatResponse>(
      `/workers/${encodeURIComponent(workerId)}/heartbeat`,
      { method: 'POST' }
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
    const { data, status } = await this.request<JobClaim<TPayload> | null>(
      `/workers/${encodeURIComponent(workerId)}/claim`,
      {
        method: 'POST',
        body: params || {},
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
    const { data } = await this.request<RenewLeaseResponse>(
      `/workers/${encodeURIComponent(workerId)}/jobs/${encodeURIComponent(
        jobId
      )}/heartbeat`,
      { method: 'POST' }
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
    const body: Record<string, unknown> = {};
    if (result !== undefined) {
      body.result = result;
    }

    const { data } = await this.request<CompleteJobResponse>(
      `/workers/${encodeURIComponent(workerId)}/jobs/${encodeURIComponent(
        jobId
      )}/complete`,
      {
        method: 'POST',
        body,
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
    const { data } = await this.request<FailJobResponse>(
      `/workers/${encodeURIComponent(workerId)}/jobs/${encodeURIComponent(
        jobId
      )}/fail`,
      {
        method: 'POST',
        body: params,
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
    const { data } = await this.request<WorkerRecord>(
      `/workers/${encodeURIComponent(workerId)}/drain`,
      { method: 'POST' }
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
    const { data } = await this.request<DeregisterWorkerResponse>(
      `/workers/${encodeURIComponent(workerId)}/deregister`,
      { method: 'POST' }
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

  private async request<T>(
    path: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    }
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const fetchImpl = this.customFetch || globalThis.fetch;
    if (!fetchImpl) {
      throw new VeyraError(
        'No fetch implementation available. Node 18+ or a global fetch polyfill is required.'
      );
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    };

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.defaultTimeoutMs);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: options.method,
        headers,
        body: bodyStr,
        signal: options.signal || controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error)?.name === 'AbortError') {
        throw new VeyraError(
          `Request timed out after ${this.defaultTimeoutMs}ms: ${url}`
        );
      }
      throw new VeyraError(
        `Network error while fetching ${url}: ${(err as Error).message}`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 204) {
      return { data: undefined as unknown as T, status: 204, headers: res.headers };
    }

    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errorMessage =
        (typeof parsed === 'object' &&
          parsed !== null &&
          'error' in parsed &&
          typeof (parsed as { error: unknown }).error === 'string' &&
          (parsed as { error: string }).error) ||
        res.statusText ||
        `HTTP ${res.status}`;

      if (res.status === 401 || res.status === 403) {
        throw new VeyraAuthError(res.status, res.statusText, errorMessage, parsed);
      }
      if (res.status === 404) {
        throw new VeyraNotFoundError(res.status, res.statusText, errorMessage, parsed);
      }
      if (res.status === 409) {
        if (
          typeof errorMessage === 'string' &&
          (errorMessage.includes('lease') || errorMessage.includes('expired'))
        ) {
          throw new LeaseLostError(errorMessage);
        }
        throw new VeyraConflictError(res.status, res.statusText, errorMessage, parsed);
      }
      throw new VeyraApiError(res.status, res.statusText, errorMessage, parsed);
    }

    return { data: parsed as T, status: res.status, headers: res.headers };
  }
}
