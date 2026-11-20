/**
 * Veyra HTTP Worker Engine
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
  HandlerFn,
  JobClaim,
  JobContext,
  RenewLeaseResponse,
  VeyraWorkerOptions,
  WorkerRecord,
} from './types.js';

export class VeyraWorker {
  readonly client: VeyraClient;
  readonly options: VeyraWorkerOptions;
  readonly handlers: Map<string, HandlerFn<any, any>> = new Map();

  private _workerId: string;
  private _state: 'stopped' | 'running' | 'draining' = 'stopped';
  private _inFlight = 0;
  private readonly _activeLeaseTimers = new Map<string, any>();
  private readonly _activeAbortControllers = new Map<string, AbortController>();

  private _heartbeatTimer?: any;
  private _pollTimeout?: any;
  private _drainResolver?: () => void;
  private _isRegistering = false;

  constructor(client: VeyraClient, options: VeyraWorkerOptions) {
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

  get workerId(): string {
    return this._workerId;
  }

  get state(): 'stopped' | 'running' | 'draining' {
    return this._state;
  }

  get inFlight(): number {
    return this._inFlight;
  }

  /**
   * Registers a handler for a given job handler name.
   */
  registerHandler<TPayload = unknown, TResult = unknown>(
    name: string,
    handler: HandlerFn<TPayload, TResult>
  ): this {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new VeyraError('registerHandler: name must not be empty');
    }
    this.handlers.set(trimmed, handler);
    return this;
  }

  /**
   * Returns the list of handlers to subscribe to.
   * If `options.handlers` is omitted or empty, defaults to all registered handler names.
   */
  getEffectiveHandlers(): string[] {
    if (this.options.handlers && this.options.handlers.length > 0) {
      return [...this.options.handlers];
    }
    return Array.from(this.handlers.keys());
  }

  /**
   * Starts the worker: registers with Veyra API, initiates worker heartbeats,
   * and starts the claim polling loop.
   */
  async start(): Promise<WorkerRecord> {
    if (this._state === 'running') {
      throw new VeyraError('VeyraWorker is already running');
    }

    const effectiveHandlers = this.getEffectiveHandlers();
    if (effectiveHandlers.length === 0) {
      throw new VeyraError(
        'VeyraWorker: No handlers registered. Call registerHandler() or pass handlers in options before starting.'
      );
    }

    this._state = 'running';

    const record = await this.register();
    this.startWorkerHeartbeatLoop();
    this.triggerClaimLoop();

    return record;
  }

  /**
   * Stops the worker: stops claiming new jobs, transitions state to draining,
   * waits for active in-flight jobs to finish, cancels timers, and deregisters.
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

  /**
   * Registers or re-registers the worker with the Veyra API.
   */
  private async register(): Promise<WorkerRecord> {
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

  /**
   * Starts periodic worker-level heartbeats. If a 404 is encountered (e.g. server evicted worker),
   * transparently re-registers.
   */
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
          // Worker was pruned/evicted from server; re-register!
          try {
            await this.register();
          } catch (regErr) {
            this.options.onError?.(regErr);
          }
        } else {
          this.options.onError?.(err);
        }
      }
    }, interval);

    // Prevent blocking Node.js event loop shutdown if unref exists
    if (typeof (this._heartbeatTimer as any)?.unref === 'function') {
      (this._heartbeatTimer as any).unref();
    }
  }

  /**
   * Schedules next claim check.
   */
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

    if (typeof (this._pollTimeout as any)?.unref === 'function') {
      (this._pollTimeout as any).unref();
    }
  }

  /**
   * Claims and dispatches available jobs up to the configured concurrency limit.
   */
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
        // Worker record lost on server; re-register and retry
        try {
          await this.register();
          this.triggerClaimLoop(100);
          return;
        } catch (regErr) {
          this.options.onError?.(regErr);
        }
      } else {
        this.options.onError?.(err);
      }

      // On error, back off before next poll
      this.triggerClaimLoop(this.options.pollIntervalMs ?? 1_000);
      return;
    }

    if (!claimResult) {
      this.triggerClaimLoop(this.options.pollIntervalMs ?? 1_000);
      return;
    }

    this._inFlight++;
    this.options.onJobStart?.(claimResult);

    // Run job execution asynchronously so claim loop can continue claiming
    // up to the concurrency limit
    void this.executeJob(claimResult).finally(() => {
      this._inFlight--;
      if (this._state === 'draining' && this._inFlight === 0) {
        this._drainResolver?.();
      } else if (this._state === 'running') {
        this.triggerClaimLoop(0);
      }
    });

    // If concurrency has headroom, immediately check if more jobs are waiting
    if (this._inFlight < maxConcurrency && this._state === 'running') {
      this.triggerClaimLoop(0);
    }
  }

  /**
   * Executes a claimed job: establishes background lease renewal, calls the registered handler,
   * handles 409 lease expiration abort signals, and reports completion or failure.
   */
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

  /**
   * Starts periodic lease heartbeats for an in-flight job.
   * If a 409 Conflict is returned, lease renewal stops immediately and the job's signal is aborted.
   */
  private startJobLeaseRenewal(
    jobId: string,
    abortController: AbortController
  ): void {
    const interval = this.options.leaseHeartbeatIntervalMs ?? 10_000;

    const timer = setInterval(async () => {
      try {
        await this.client.renewJobLease(this._workerId, jobId);
      } catch (err) {
        // If 409 Conflict or LeaseLostError: STOP renewing lease immediately!
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

        // If worker was evicted, re-register
        if (err instanceof VeyraNotFoundError) {
          try {
            await this.register();
          } catch (regErr) {
            this.options.onError?.(regErr);
          }
        } else {
          this.options.onError?.(err);
        }
      }
    }, interval);

    if (typeof (timer as any)?.unref === 'function') {
      (timer as any).unref();
    }

    this._activeLeaseTimers.set(jobId, timer);
  }

  /**
   * Stops renewing a job's lease.
   */
  private stopJobLeaseRenewal(jobId: string): void {
    const timer = this._activeLeaseTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this._activeLeaseTimers.delete(jobId);
    }
  }
}
