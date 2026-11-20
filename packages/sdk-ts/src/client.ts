/**
 * Veyra HTTP Client
 */

import {
  LeaseLostError,
  VeyraApiError,
  VeyraAuthError,
  VeyraConflictError,
  VeyraError,
  VeyraNotFoundError,
} from './errors.js';
import type {
  ClaimParams,
  CompleteJobResponse,
  EnqueueJobInput,
  FailJobParams,
  FailJobResponse,
  HeartbeatResponse,
  Job,
  JobClaim,
  RenewLeaseResponse,
  VeyraClientConfig,
  VeyraWorkerOptions,
  WorkerRecord,
  WorkerRegisterParams,
} from './types.js';
import { VeyraWorker } from './worker.js';

export class VeyraClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultQueue: string;
  private readonly customFetch?: typeof fetch;
  private readonly defaultTimeoutMs: number;

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
   * Enqueues a job into Veyra's queue.
   */
  async enqueue<TPayload = unknown, TResult = unknown>(
    input: EnqueueJobInput<TPayload>
  ): Promise<Job<TPayload, TResult>> {
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
      body.scheduledFor =
        input.scheduledFor instanceof Date
          ? input.scheduledFor.toISOString()
          : input.scheduledFor;
    }
    if (input.idempotencyKey) {
      body.idempotencyKey = input.idempotencyKey.trim();
    }
    if (input.callbackUrl) {
      body.callbackUrl = input.callbackUrl.trim();
    }

    const headers: Record<string, string> = {};
    if (input.idempotencyKey) {
      headers['Idempotency-Key'] = input.idempotencyKey.trim();
    }

    const { data, headers: resHeaders } = await this.request<Job<TPayload, TResult>>(
      '/jobs',
      {
        method: 'POST',
        headers,
        body,
      }
    );

    if (resHeaders.get('idempotent-replay') === 'true') {
      data.isReplay = true;
    }

    return data;
  }

  /**
   * Retrieves a job by ID.
   */
  async getJob<TPayload = unknown, TResult = unknown>(
    jobId: string
  ): Promise<Job<TPayload, TResult>> {
    if (!jobId?.trim()) {
      throw new VeyraError('getJob: jobId is required');
    }
    const { data } = await this.request<Job<TPayload, TResult>>(
      `/jobs/${encodeURIComponent(jobId.trim())}`,
      { method: 'GET' }
    );
    return data;
  }

  /**
   * Cancels a job by ID.
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
   * Registers a worker in the Veyra cluster.
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
   */
  async heartbeatWorker(workerId: string): Promise<HeartbeatResponse> {
    const { data } = await this.request<HeartbeatResponse>(
      `/workers/${encodeURIComponent(workerId)}/heartbeat`,
      { method: 'POST' }
    );
    return data;
  }

  /**
   * Claims a job for execution. Returns null if queue is empty (204 No Content).
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
   * Marks a job as completed with optional result payload.
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
   * Transitions worker state to draining.
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
   */
  async deregisterWorker(
    workerId: string
  ): Promise<{ deregistered: boolean; workerId: string }> {
    const { data } = await this.request<{ deregistered: boolean; workerId: string }>(
      `/workers/${encodeURIComponent(workerId)}/deregister`,
      { method: 'POST' }
    );
    return data;
  }

  /**
   * Creates a VeyraWorker managed instance tied to this client.
   */
  createWorker(options: VeyraWorkerOptions): VeyraWorker {
    return new VeyraWorker(this, options);
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
        throw new VeyraError(`Request timed out after ${this.defaultTimeoutMs}ms: ${url}`);
      }
      throw new VeyraError(`Network error while fetching ${url}: ${(err as Error).message}`);
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
