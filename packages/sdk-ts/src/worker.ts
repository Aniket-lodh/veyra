/**
 * Veyra HTTP worker engine.
 */

import type { VeyraClient } from './client.js';
import {
  isNonRetryable,
  LeaseLostError,
  VeyraConflictError,
  VeyraError,
  VeyraNotFoundError,
  VeyraValidationError,
} from './errors.js';
import type {
  BuiltInHandlers,
  HandlerDefinition,
  HandlerName,
  HandlerPayloadFor,
  HandlerResultFor,
  ResolvedHandlers,
} from './handlers.js';
import { validateWithSchema } from './standard-schema.js';
import type {
  HandlerFn,
  JobClaim,
  JobContext,
  RenewLeaseResponse,
  VeyraWorkerOptions,
  WorkerRecord,
} from './types.js';

type TimerHandle = ReturnType<typeof setTimeout>;

function unrefTimer(timer: TimerHandle | undefined): void {
  const maybe = timer as unknown as { unref?: () => void } | undefined;
  if (typeof maybe?.unref === 'function') {
    maybe.unref();
  }
}

/**
 * Long-polling worker that registers with Veyra, claims jobs, renews leases,
 * executes handlers, and reports outcomes.
 *
 * @typeParam THandlers - Extra handler contracts merged over {@link BuiltInHandlers}.
 *
 * @example
 * ```ts
 * const worker = client.createWorker({ queues: ['default'] });
 * worker.register(sendEmail, async (job) => ({ messageId: await send(job.payload) }));
 * await worker.start();
 * ```
 */
export class VeyraWorker<THandlers extends object = BuiltInHandlers> {
  readonly #client: VeyraClient<THandlers>;
  readonly #options: VeyraWorkerOptions;
  readonly #handlers: Map<string, HandlerFn<any, any>> = new Map();

  #workerId: string;
  #state: 'stopped' | 'running' | 'draining' = 'stopped';
  #inFlight = 0;
  readonly #activeLeaseTimers = new Map<string, TimerHandle>();
  readonly #activeAbortControllers = new Map<string, AbortController>();

  #heartbeatTimer?: TimerHandle;
  #pollTimeout?: TimerHandle;
  #drainResolver?: () => void;
  #isRegistering = false;
  #consecutivePollErrors = 0;

  /**
   * @param client - Client used for API calls.
   * @param options - Queues, concurrency, timings, and lifecycle callbacks.
   * @throws {VeyraValidationError} When options fail validation.
   */
  constructor(client: VeyraClient<THandlers>, options: VeyraWorkerOptions) {
    if (!options || typeof options !== 'object') {
      throw new VeyraValidationError('options', [{ message: 'VeyraWorkerOptions must be an object' }]);
    }

    if (!Array.isArray(options.queues) || options.queues.length === 0) {
      throw new VeyraValidationError('queues', [{ message: 'queues must be a non-empty array of queue names' }]);
    }
    const queues = options.queues.map((q, idx) => {
      if (typeof q !== 'string' || !q.trim()) {
        throw new VeyraValidationError(`queues[${idx}]`, [{ message: 'queue name must be a non-empty string' }]);
      }
      return q.trim();
    });

    const concurrency = options.concurrency ?? 5;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) {
      throw new VeyraValidationError('concurrency', [{ message: 'concurrency must be an integer between 1 and 1000' }]);
    }

    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new VeyraValidationError('pollIntervalMs', [{ message: 'pollIntervalMs must be a positive finite number' }]);
    }

    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
      throw new VeyraValidationError('heartbeatIntervalMs', [{ message: 'heartbeatIntervalMs must be a positive finite number' }]);
    }

    const leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? 10_000;
    if (!Number.isFinite(leaseHeartbeatIntervalMs) || leaseHeartbeatIntervalMs <= 0) {
      throw new VeyraValidationError('leaseHeartbeatIntervalMs', [{ message: 'leaseHeartbeatIntervalMs must be a positive finite number' }]);
    }

    this.#client = client;
    this.#options = {
      ...options,
      queues,
      concurrency,
      pollIntervalMs,
      heartbeatIntervalMs,
      leaseHeartbeatIntervalMs,
    };

    this.#workerId =
      this.#options.workerId?.trim() ||
      `worker-${Math.random().toString(36).substring(2, 10)}`;
  }

  /** Worker id used on every worker-protocol call. */
  get workerId(): string {
    return this.#workerId;
  }

  /** Current lifecycle state. */
  get state(): 'stopped' | 'running' | 'draining' {
    return this.#state;
  }

  /** Number of jobs currently executing. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Bound client. */
  get client(): VeyraClient<THandlers> {
    return this.#client;
  }

  /** Resolved worker options. */
  get options(): VeyraWorkerOptions {
    return { ...this.#options };
  }

  /** Registered handlers map view. */
  get handlers(): Map<string, HandlerFn<any, any>> {
    return new Map(this.#handlers);
  }

  /**
   * Safe JSON representation redacting all sensitive credentials.
   */
  toJSON(): Record<string, unknown> {
    return {
      workerId: this.#workerId,
      state: this.#state,
      inFlight: this.#inFlight,
      queues: [...this.#options.queues],
      concurrency: this.#options.concurrency,
      handlers: Array.from(this.#handlers.keys()),
    };
  }

  /**
   * Node.js custom inspection hook redacting all sensitive credentials from console output.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
    return this.toJSON();
  }

  /**
   * Registers a typed handler definition.
   *
   * The payload is validated before the callback runs; the returned value is
   * validated before completion is reported to Veyra. Both failures raise
   * {@link VeyraValidationError}, which is permanent.
   *
   * @param definition - Definition created with `defineHandler`.
   * @param handler - Callback receiving a typed payload and returning the result.
   * @throws {VeyraError} When a handler with the same name is already registered.
   *
   * @example
   * ```ts
   * worker.register(sendEmail, async (job) => ({ messageId: await send(job.payload) }));
   * ```
   */
  register<
    TName extends string,
    TPayload,
    TResult,
    TQueue extends string | undefined
  >(
    definition: HandlerDefinition<TName, TPayload, TResult, TQueue>,
    handler: (job: JobClaim<TPayload>, ctx: JobContext) => TResult | Promise<TResult>
  ): this;

  /**
   * Registers a handler by name.
   *
   * Built-in and `THandlers` names get autocomplete and typed payload/result;
   * arbitrary string names fall back to the supplied generics.
   *
   * @param name - Handler name matched against claimed jobs.
   * @param handler - Callback receiving the claimed job and context.
   * @throws {VeyraError} When a handler with the same name is already registered.
   */
  register<
    TPayload = unknown,
    TResult = unknown,
    const TName extends HandlerName<ResolvedHandlers<THandlers>> | (string & {}) =
      | HandlerName<ResolvedHandlers<THandlers>>
      | (string & {})
  >(
    name: TName,
    handler: HandlerFn<
      HandlerPayloadFor<ResolvedHandlers<THandlers>, TName, TPayload>,
      HandlerResultFor<ResolvedHandlers<THandlers>, TName, TResult>
    >
  ): this;

  register(
    nameOrDefinition: string | HandlerDefinition,
    handler: HandlerFn<any, any>
  ): this {
    if (typeof nameOrDefinition === 'string') {
      return this.#setHandler(nameOrDefinition, handler);
    }

    const definition = nameOrDefinition;
    const wrapped: HandlerFn<any, any> = async (job, ctx) => {
      const payload = await validateWithSchema(
        definition.payload,
        job.payload,
        `handler '${definition.name}' payload`
      );
      const result = await handler({ ...job, payload }, ctx);
      return validateWithSchema(
        definition.result,
        result,
        `handler '${definition.name}' result`
      );
    };
    return this.#setHandler(definition.name, wrapped);
  }

  /**
   * Registers a handler by name without a definition. Prefer {@link register}
   * with a `defineHandler` definition for payload/result typing.
   *
   * @param name - Handler name matched against claimed jobs.
   * @param handler - Callback receiving the claimed job and context.
   * @throws {VeyraError} When a handler with the same name is already registered.
   */
  registerHandler<TPayload = unknown, TResult = unknown>(
    name: string,
    handler: HandlerFn<TPayload, TResult>
  ): this {
    return this.#setHandler(name, handler);
  }

  /**
   * Returns the handler names advertised at registration.
   * Defaults to every registered handler when `options.handlers` is empty.
   */
  getEffectiveHandlers(): string[] {
    if (this.#options.handlers && this.#options.handlers.length > 0) {
      return [...this.#options.handlers];
    }
    return Array.from(this.#handlers.keys());
  }

  /**
   * Registers with Veyra, starts heartbeats, and begins claiming jobs.
   *
   * @returns The worker record stored by the API.
   * @throws {VeyraError} When already running or no handlers are registered.
   */
  async start(): Promise<WorkerRecord> {
    if (this.#state === 'running') {
      throw new VeyraError('VeyraWorker is already running', { code: 'ALREADY_RUNNING' });
    }

    const effectiveHandlers = this.getEffectiveHandlers();
    if (effectiveHandlers.length === 0) {
      throw new VeyraError(
        'VeyraWorker: No handlers registered. Call register() or registerHandler() before starting.'
      );
    }

    this.#state = 'running';

    const record = await this.#registerWorkerRecord();
    this.#startWorkerHeartbeatLoop();
    this.#triggerClaimLoop();

    return record;
  }

  /**
   * Stops claiming, drains in-flight jobs, cancels timers, and deregisters.
   *
   * @param options.timeoutMs - Maximum drain wait. Defaults to `30000`.
   */
  async stop(options?: { timeoutMs?: number }): Promise<void> {
    if (this.#state === 'stopped') {
      return;
    }

    this.#state = 'draining';

    if (this.#pollTimeout) {
      clearTimeout(this.#pollTimeout);
      this.#pollTimeout = undefined;
    }

    try {
      await this.#client.drainWorker(this.#workerId);
    } catch (err) {
      this.#options.onError?.(err);
      this.#options.logger?.warn?.(`Worker drain failed for ${this.#workerId}`, {
        error: (err as Error).message,
      });
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    if (this.#inFlight > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.#drainResolver = resolve;
        }),
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new VeyraError(
                  `Worker drain timed out after ${timeoutMs}ms with ${this.#inFlight} jobs remaining`
                )
              ),
            timeoutMs
          )
        ),
      ]).catch((err) => {
        this.#options.onError?.(err);
      });
    }

    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }

    for (const [, timer] of this.#activeLeaseTimers) {
      clearInterval(timer);
    }
    this.#activeLeaseTimers.clear();
    this.#activeAbortControllers.clear();

    try {
      await this.#client.deregisterWorker(this.#workerId);
    } catch (err) {
      this.#options.onError?.(err);
      this.#options.logger?.warn?.(`Worker deregister failed for ${this.#workerId}`, {
        error: (err as Error).message,
      });
    }

    this.#state = 'stopped';
    this.#drainResolver = undefined;
  }

  #setHandler(name: string, handler: HandlerFn<any, any>): this {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new VeyraValidationError('name', [{ message: 'Handler name must not be empty' }]);
    }
    if (this.#handlers.has(trimmed)) {
      throw new VeyraError(
        `Handler '${trimmed}' is already registered on this worker. Registering multiple handlers with the same name is not allowed.`,
        { code: 'DUPLICATE_HANDLER' }
      );
    }
    this.#handlers.set(trimmed, handler);
    return this;
  }

  async #registerWorkerRecord(): Promise<WorkerRecord> {
    if (this.#isRegistering) {
      return {} as WorkerRecord;
    }
    this.#isRegistering = true;
    try {
      const proc =
        typeof globalThis !== 'undefined'
          ? (globalThis as unknown as { process?: { env?: Record<string, string>; pid?: number } }).process
          : undefined;
      const effectiveHandlers = this.getEffectiveHandlers();
      const record = await this.#client.registerWorker({
        id: this.#workerId,
        hostname: this.#options.hostname || proc?.env?.HOSTNAME || 'external-sdk',
        pid: this.#options.pid || proc?.pid || 0,
        version: this.#options.version || '0.1.0',
        queues: this.#options.queues,
        handlers: effectiveHandlers,
        maxConcurrency: this.#options.concurrency ?? 5,
        heartbeatIntervalSeconds: Math.max(
          1,
          Math.floor((this.#options.heartbeatIntervalMs ?? 10_000) / 1000)
        ),
      });

      if (record?.id) {
        this.#workerId = record.id;
      }
      return record;
    } finally {
      this.#isRegistering = false;
    }
  }

  #startWorkerHeartbeatLoop(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
    }

    const interval = this.#options.heartbeatIntervalMs ?? 10_000;
    this.#heartbeatTimer = setInterval(async () => {
      if (this.#state === 'stopped') {
        return;
      }

      try {
        await this.#client.heartbeatWorker(this.#workerId);
      } catch (err) {
        if (err instanceof VeyraNotFoundError) {
          try {
            await this.#registerWorkerRecord();
          } catch (regErr) {
            this.#options.onError?.(regErr);
            this.#options.logger?.error?.('Worker re-registration failed', {
              error: (regErr as Error).message,
            });
          }
        } else {
          this.#options.onError?.(err);
          this.#options.logger?.warn?.('Worker heartbeat failed', {
            error: (err as Error).message,
          });
        }
      }
    }, interval);

    unrefTimer(this.#heartbeatTimer);
  }

  #triggerClaimLoop(delayMs = 0): void {
    if (this.#state !== 'running') {
      return;
    }

    if (this.#pollTimeout) {
      clearTimeout(this.#pollTimeout);
    }

    this.#pollTimeout = setTimeout(() => {
      this.#pollTimeout = undefined;
      void this.#claimAndDispatch();
    }, delayMs);

    unrefTimer(this.#pollTimeout);
  }

  async #claimAndDispatch(): Promise<void> {
    if (this.#state !== 'running') {
      return;
    }

    const maxConcurrency = this.#options.concurrency ?? 5;
    if (this.#inFlight >= maxConcurrency) {
      return;
    }

    const effectiveHandlers = this.getEffectiveHandlers();
    let claimResult: JobClaim | null = null;

    try {
      claimResult = await this.#client.claimJob(this.#workerId, {
        queues: this.#options.queues,
        handlers: effectiveHandlers,
      });
      this.#consecutivePollErrors = 0;
    } catch (err) {
      this.#consecutivePollErrors++;
      const baseDelay = this.#options.pollIntervalMs ?? 1_000;
      const backoffDelay = Math.min(
        30_000,
        baseDelay * Math.pow(1.5, Math.min(this.#consecutivePollErrors, 10))
      );

      if (err instanceof VeyraNotFoundError) {
        try {
          await this.#registerWorkerRecord();
          this.#triggerClaimLoop(100);
          return;
        } catch (regErr) {
          this.#options.onError?.(regErr);
          this.#options.logger?.error?.('Worker re-registration failed', {
            error: (regErr as Error).message,
          });
        }
      } else {
        this.#options.onError?.(err);
        this.#options.logger?.warn?.(
          `Worker claim failed, backing off for ${Math.round(backoffDelay)}ms`,
          { error: (err as Error).message, consecutiveErrors: this.#consecutivePollErrors }
        );
      }

      this.#triggerClaimLoop(backoffDelay);
      return;
    }

    if (!claimResult) {
      this.#triggerClaimLoop(this.#options.pollIntervalMs ?? 1_000);
      return;
    }

    this.#inFlight++;
    this.#options.onJobStart?.(claimResult);

    void this.#executeJob(claimResult).finally(() => {
      this.#inFlight--;
      if (this.#state === 'draining' && this.#inFlight === 0) {
        this.#drainResolver?.();
      } else if (this.#state === 'running') {
        this.#triggerClaimLoop(0);
      }
    });

    if (this.#inFlight < maxConcurrency && this.#state === 'running') {
      this.#triggerClaimLoop(0);
    }
  }

  async #executeJob(job: JobClaim): Promise<void> {
    const abortController = new AbortController();
    this.#activeAbortControllers.set(job.id, abortController);

    this.#startJobLeaseRenewal(job.id, abortController);

    const ctx: JobContext = {
      jobId: job.id,
      attempt: job.attempt,
      queue: job.queue,
      handler: job.handler,
      signal: abortController.signal,
      extendLease: async (): Promise<RenewLeaseResponse> => {
        return this.#client.renewJobLease(this.#workerId, job.id);
      },
    };

    const handlerFn = this.#handlers.get(job.handler);

    try {
      if (!handlerFn) {
        throw new VeyraError(
          `No registered handler found for '${job.handler}'`
        );
      }

      const result = await handlerFn(job, ctx);

      this.#stopJobLeaseRenewal(job.id);

      await this.#client.completeJob(this.#workerId, job.id, result);
      this.#options.onJobComplete?.(job, result);
    } catch (err) {
      this.#stopJobLeaseRenewal(job.id);

      // SPEC §1.2 / §4: If the job lease was lost/expired, the worker context was aborted.
      // Do not ack or nack: leave the lease to expire cleanly so the queue supervisor reclaims it.
      if (
        abortController.signal.aborted &&
        abortController.signal.reason instanceof LeaseLostError
      ) {
        this.#options.onJobError?.(job, abortController.signal.reason);
        return;
      }

      const permanent = isNonRetryable(err);
      const errorClass =
        (err as { name?: string })?.name ||
        (err as { errorClass?: string })?.errorClass ||
        'HandlerError';

      const rawMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'Job execution failed';
      const message = rawMessage.length > 1000 ? `${rawMessage.slice(0, 1000)}...` : rawMessage;

      const rawStack = err instanceof Error ? err.stack : undefined;
      const stackTrace = rawStack && rawStack.length > 4000 ? `${rawStack.slice(0, 4000)}...` : rawStack;

      try {
        await this.#client.failJob(this.#workerId, job.id, {
          errorClass,
          message,
          stackTrace,
          permanent,
        });
      } catch (reportErr) {
        this.#options.onError?.(reportErr);
        this.#options.logger?.error?.(`Failed reporting job ${job.id} failure to API`, {
          error: (reportErr as Error).message,
        });
      }

      this.#options.onJobError?.(job, err);
    } finally {
      this.#stopJobLeaseRenewal(job.id);
      this.#activeAbortControllers.delete(job.id);
    }
  }

  #startJobLeaseRenewal(
    jobId: string,
    abortController: AbortController
  ): void {
    const interval = this.#options.leaseHeartbeatIntervalMs ?? 10_000;

    const timer = setInterval(async () => {
      try {
        await this.#client.renewJobLease(this.#workerId, jobId);
      } catch (err) {
        if (
          err instanceof LeaseLostError ||
          err instanceof VeyraConflictError ||
          (err as { status?: number })?.status === 409
        ) {
          this.#stopJobLeaseRenewal(jobId);
          abortController.abort(
            new LeaseLostError(
              `Lease lost for job ${jobId}; stopping execution.`
            )
          );
          return;
        }

        if (err instanceof VeyraNotFoundError) {
          try {
            await this.#registerWorkerRecord();
          } catch (regErr) {
            this.#options.onError?.(regErr);
            this.#options.logger?.error?.('Worker re-registration failed', {
              error: (regErr as Error).message,
            });
          }
        } else {
          this.#options.onError?.(err);
          this.#options.logger?.warn?.(`Job ${jobId} lease renewal failed`, {
            error: (err as Error).message,
          });
        }
      }
    }, interval);

    unrefTimer(timer);

    this.#activeLeaseTimers.set(jobId, timer);
  }

  #stopJobLeaseRenewal(jobId: string): void {
    const timer = this.#activeLeaseTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.#activeLeaseTimers.delete(jobId);
    }
  }
}
