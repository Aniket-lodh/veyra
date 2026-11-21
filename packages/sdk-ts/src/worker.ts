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

/**
 * A timer handle. Browsers return `number`; Node returns a `Timeout` object
 * with `unref()`. Kept opaque so one build serves both runtimes.
 */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Detaches a timer so it cannot keep a Node process alive. No-op in browsers
 * and in other runtimes whose timer handles have no `unref`.
 */
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
  /** Client used for every API call. */
  readonly client: VeyraClient<THandlers>;
  /** Resolved worker options, including defaults. */
  readonly options: VeyraWorkerOptions;
  /** Registered handler callbacks, keyed by handler name. */
  readonly handlers: Map<string, HandlerFn<any, any>> = new Map();

  private _workerId: string;
  private _state: 'stopped' | 'running' | 'draining' = 'stopped';
  private _inFlight = 0;
  private readonly _activeLeaseTimers = new Map<string, TimerHandle>();
  private readonly _activeAbortControllers = new Map<string, AbortController>();

  private _heartbeatTimer?: TimerHandle;
  private _pollTimeout?: TimerHandle;
  private _drainResolver?: () => void;
  private _isRegistering = false;

  /**
   * @param client - Client used for API calls.
   * @param options - Queues, concurrency, timings, and lifecycle callbacks.
   * @throws {VeyraError} When no queue is supplied.
   */
  constructor(client: VeyraClient<THandlers>, options: VeyraWorkerOptions) {
    this.client = client;
    this.options = {
      concurrency: 5,
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 10_000,
      leaseHeartbeatIntervalMs: 10_000,
      ...options,
    };

    if (!this.options.queues || this.options.queues.length === 0) {
      throw new VeyraError('VeyraWorker: at least one queue must be specified');
    }

    this._workerId =
      this.options.workerId ||
      `worker-${Math.random().toString(36).substring(2, 10)}`;
  }

  /** Worker id used on every worker-protocol call. */
  get workerId(): string {
    return this._workerId;
  }

  /** Current lifecycle state. */
  get state(): 'stopped' | 'running' | 'draining' {
    return this._state;
  }

  /** Number of jobs currently executing. */
  get inFlight(): number {
    return this._inFlight;
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
   * Built-in and `THandlers` names get typed payload/result; arbitrary string
   * names fall back to the supplied generics.
   *
   * @param name - Handler name matched against claimed jobs.
   * @param handler - Callback receiving the claimed job and context.
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
      return this.setHandler(nameOrDefinition, handler);
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
    return this.setHandler(definition.name, wrapped);
  }

  /**
   * Registers a handler by name without a definition. Prefer {@link register}
   * with a `defineHandler` definition for payload/result typing.
   *
   * @param name - Handler name matched against claimed jobs.
   * @param handler - Callback receiving the claimed job and context.
   */
  registerHandler<TPayload = unknown, TResult = unknown>(
    name: string,
    handler: HandlerFn<TPayload, TResult>
  ): this {
    return this.setHandler(name, handler);
  }

  /**
   * Returns the handler names advertised at registration.
   * Defaults to every registered handler when `options.handlers` is empty.
   */
  getEffectiveHandlers(): string[] {
    if (this.options.handlers && this.options.handlers.length > 0) {
      return [...this.options.handlers];
    }
    return Array.from(this.handlers.keys());
  }

  /**
   * Registers with Veyra, starts heartbeats, and begins claiming jobs.
   *
   * @returns The worker record stored by the API.
   * @throws {VeyraError} When already running or no handlers are registered.
   */
  async start(): Promise<WorkerRecord> {
    if (this._state === 'running') {
      throw new VeyraError('VeyraWorker is already running');
    }

    const effectiveHandlers = this.getEffectiveHandlers();
    if (effectiveHandlers.length === 0) {
      throw new VeyraError(
        'VeyraWorker: No handlers registered. Call register() or registerHandler() before starting.'
      );
    }

    this._state = 'running';

    const record = await this.registerWorkerRecord();
    this.startWorkerHeartbeatLoop();
    this.triggerClaimLoop();

    return record;
  }

  /**
   * Stops claiming, drains in-flight jobs, cancels timers, and deregisters.
   *
   * @param options.timeoutMs - Maximum drain wait. Defaults to `30000`.
   */
  async stop(options?: { timeoutMs?: number }): Promise<void> {
    if (this._state === 'stopped') {
      return;
    }

    this._state = 'draining';

    if (this._pollTimeout) {
      clearTimeout(this._pollTimeout);
      this._pollTimeout = undefined;
    }

    try {
      await this.client.drainWorker(this._workerId);
    } catch (err) {
      this.options.onError?.(err);
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    if (this._inFlight > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          this._drainResolver = resolve;
        }),
        new Promise<void>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new VeyraError(
                  `Worker drain timed out after ${timeoutMs}ms with ${this._inFlight} jobs remaining`
                )
              ),
            timeoutMs
          )
        ),
      ]).catch((err) => {
        this.options.onError?.(err);
      });
    }

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = undefined;
    }

    for (const [, timer] of this._activeLeaseTimers) {
      clearInterval(timer);
    }
    this._activeLeaseTimers.clear();
    this._activeAbortControllers.clear();

    try {
      await this.client.deregisterWorker(this._workerId);
    } catch (err) {
      this.options.onError?.(err);
    }

    this._state = 'stopped';
    this._drainResolver = undefined;
  }

  private setHandler(name: string, handler: HandlerFn<any, any>): this {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new VeyraError('register: name must not be empty');
    }
    this.handlers.set(trimmed, handler);
    return this;
  }

  private async registerWorkerRecord(): Promise<WorkerRecord> {
    if (this._isRegistering) {
      return {} as WorkerRecord;
    }
    this._isRegistering = true;
    try {
      const proc =
        typeof globalThis !== 'undefined'
          ? (globalThis as unknown as { process?: { env?: Record<string, string>; pid?: number } }).process
          : undefined;
      const effectiveHandlers = this.getEffectiveHandlers();
      const record = await this.client.registerWorker({
        id: this._workerId,
        hostname: this.options.hostname || proc?.env?.HOSTNAME || 'external-sdk',
        pid: this.options.pid || proc?.pid || 0,
        version: this.options.version || '0.1.0',
        queues: this.options.queues,
        handlers: effectiveHandlers,
        maxConcurrency: this.options.concurrency ?? 5,
        heartbeatIntervalSeconds: Math.max(
          1,
          Math.floor((this.options.heartbeatIntervalMs ?? 10_000) / 1000)
        ),
      });

      if (record?.id) {
        this._workerId = record.id;
      }
      return record;
    } finally {
      this._isRegistering = false;
    }
  }

  private startWorkerHeartbeatLoop(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }

    const interval = this.options.heartbeatIntervalMs ?? 10_000;
    this._heartbeatTimer = setInterval(async () => {
      if (this._state === 'stopped') {
        return;
      }

      try {
        await this.client.heartbeatWorker(this._workerId);
      } catch (err) {
        if (err instanceof VeyraNotFoundError) {
          try {
            await this.registerWorkerRecord();
          } catch (regErr) {
            this.options.onError?.(regErr);
          }
        } else {
          this.options.onError?.(err);
        }
      }
    }, interval);

    unrefTimer(this._heartbeatTimer);
  }

  private triggerClaimLoop(delayMs = 0): void {
    if (this._state !== 'running') {
      return;
    }

    if (this._pollTimeout) {
      clearTimeout(this._pollTimeout);
    }

    this._pollTimeout = setTimeout(() => {
      this._pollTimeout = undefined;
      void this.claimAndDispatch();
    }, delayMs);

    unrefTimer(this._pollTimeout);
  }

  private async claimAndDispatch(): Promise<void> {
    if (this._state !== 'running') {
      return;
    }

    const maxConcurrency = this.options.concurrency ?? 5;
    if (this._inFlight >= maxConcurrency) {
      return;
    }

    const effectiveHandlers = this.getEffectiveHandlers();
    let claimResult: JobClaim | null = null;

    try {
      claimResult = await this.client.claimJob(this._workerId, {
        queues: this.options.queues,
        handlers: effectiveHandlers,
      });
    } catch (err) {
      if (err instanceof VeyraNotFoundError) {
        try {
          await this.registerWorkerRecord();
          this.triggerClaimLoop(100);
          return;
        } catch (regErr) {
          this.options.onError?.(regErr);
        }
      } else {
        this.options.onError?.(err);
      }

      this.triggerClaimLoop(this.options.pollIntervalMs ?? 1_000);
      return;
    }

    if (!claimResult) {
      this.triggerClaimLoop(this.options.pollIntervalMs ?? 1_000);
      return;
    }

    this._inFlight++;
    this.options.onJobStart?.(claimResult);

    void this.executeJob(claimResult).finally(() => {
      this._inFlight--;
      if (this._state === 'draining' && this._inFlight === 0) {
        this._drainResolver?.();
      } else if (this._state === 'running') {
        this.triggerClaimLoop(0);
      }
    });

    if (this._inFlight < maxConcurrency && this._state === 'running') {
      this.triggerClaimLoop(0);
    }
  }

  private async executeJob(job: JobClaim): Promise<void> {
    const abortController = new AbortController();
    this._activeAbortControllers.set(job.id, abortController);

    this.startJobLeaseRenewal(job.id, abortController);

    const ctx: JobContext = {
      jobId: job.id,
      attempt: job.attempt,
      queue: job.queue,
      handler: job.handler,
      signal: abortController.signal,
      extendLease: async (): Promise<RenewLeaseResponse> => {
        return this.client.renewJobLease(this._workerId, job.id);
      },
    };

    const handlerFn = this.handlers.get(job.handler);

    try {
      if (!handlerFn) {
        throw new VeyraError(
          `No registered handler found for '${job.handler}'`
        );
      }

      const result = await handlerFn(job, ctx);

      this.stopJobLeaseRenewal(job.id);

      await this.client.completeJob(this._workerId, job.id, result);
      this.options.onJobComplete?.(job, result);
    } catch (err) {
      this.stopJobLeaseRenewal(job.id);

      const permanent = isNonRetryable(err);
      const errorClass =
        (err as { name?: string })?.name ||
        (err as { errorClass?: string })?.errorClass ||
        'HandlerError';
      const message =
        (err as Error)?.message ||
        (typeof err === 'string' ? err : 'Job execution failed');
      const stackTrace = (err as Error)?.stack;

      try {
        await this.client.failJob(this._workerId, job.id, {
          errorClass,
          message,
          stackTrace,
          permanent,
        });
      } catch (reportErr) {
        this.options.onError?.(reportErr);
      }

      this.options.onJobError?.(job, err);
    } finally {
      this.stopJobLeaseRenewal(job.id);
      this._activeAbortControllers.delete(job.id);
    }
  }

  private startJobLeaseRenewal(
    jobId: string,
    abortController: AbortController
  ): void {
    const interval = this.options.leaseHeartbeatIntervalMs ?? 10_000;

    const timer = setInterval(async () => {
      try {
        await this.client.renewJobLease(this._workerId, jobId);
      } catch (err) {
        if (
          err instanceof LeaseLostError ||
          err instanceof VeyraConflictError ||
          (err as { status?: number })?.status === 409
        ) {
          this.stopJobLeaseRenewal(jobId);
          abortController.abort(
            new LeaseLostError(
              `Lease lost for job ${jobId}; stopping execution.`
            )
          );
          return;
        }

        if (err instanceof VeyraNotFoundError) {
          try {
            await this.registerWorkerRecord();
          } catch (regErr) {
            this.options.onError?.(regErr);
          }
        } else {
          this.options.onError?.(err);
        }
      }
    }, interval);

    unrefTimer(timer);

    this._activeLeaseTimers.set(jobId, timer);
  }

  private stopJobLeaseRenewal(jobId: string): void {
    const timer = this._activeLeaseTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this._activeLeaseTimers.delete(jobId);
    }
  }
}
