/**
 * Wire types for the Veyra REST API and HTTP worker protocol.
 * Every shape here mirrors `apps/api` and `apps/worker` exactly.
 */

import type {
  DefinitionPayload,
  DefinitionResult,
  HandlerDefinition,
  HandlerName,
  HandlerPayload,
  HandlerResult,
} from './handlers.js';

/** JSON value accepted anywhere the API stores opaque JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The seven-value status vocabulary returned by `GET /jobs` and `GET /jobs/:id`.
 * `scheduled` is derived from `queued` plus a future `scheduledFor`;
 * `dead-lettered` is the storage value `dead_lettered` renamed for display.
 */
export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead-lettered'
  | 'cancelled';

/**
 * The six-value status vocabulary used by queue storage and by worker
 * protocol responses (`claim`, `complete`, `fail`, webhooks).
 */
export type StorageJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled';

/** Retry strategy attached to a job. */
export type BackoffStrategy =
  | {
      /** Exponential backoff. */
      kind: 'exponential';
      /** Initial delay in seconds. */
      baseSeconds: number;
      /** Maximum delay in seconds. */
      capSeconds: number;
    }
  | {
      /** Constant delay between attempts. */
      kind: 'fixed';
      /** Delay in seconds. */
      seconds: number;
    };

/** Structured error persisted on a failed job. */
export interface JobError {
  /** Failure class, e.g. `timeout`, `http_5xx`, `HandlerError`. */
  class: string;
  /** Human-readable failure message. */
  message: string;
  /** Stack trace captured by the worker, or an empty string. */
  stackTrace: string;
  /** RFC 3339 timestamp of the failure. */
  occurredAt: string;
}

/** One execution attempt in a job's history. */
export interface JobAttempt {
  /** 1-based attempt number. */
  attemptNumber: number;
  /** Worker that executed the attempt. */
  workerId: string;
  /** RFC 3339 start timestamp. */
  startedAt: string;
  /** RFC 3339 end timestamp, or `null` while running. */
  endedAt: string | null;
  /** Duration in milliseconds, or `null` while running. */
  durationMs: number | null;
  /** `succeeded`, `failed`, `timeout`, `cancelled`, `lease-lost`, or `null`. */
  outcome: string | null;
  /** Failure class, or `null`. */
  errorClass: string | null;
  /** Failure message, or `null`. */
  errorMessage: string | null;
}

/** Delivery state of a completion webhook. */
export type CallbackStatus = 'pending' | 'running' | 'delivered' | 'failed';

/**
 * Full job representation returned by `POST /jobs`, `GET /jobs/:id`,
 * `POST /jobs/:id/cancel`, and `POST /jobs/:id/retry`.
 *
 * @typeParam TPayload - Shape of `payload`.
 * @typeParam TResult - Shape of `result` once the job succeeds.
 */
export interface Job<TPayload = unknown, TResult = unknown> {
  /** ULID, 26 characters. */
  id: string;
  /** Handler name matched by workers. */
  handler: string;
  /** Queue the job belongs to. */
  queue: string;
  /** API status vocabulary. */
  status: JobStatus;
  /** `0` (lowest) to `9` (highest). */
  priority: number;
  /** Idempotency key supplied at enqueue, or `null`. */
  idempotencyKey: string | null;
  /** Opaque payload supplied at enqueue. */
  payload: TPayload;
  /** Handler result after success, or `null`. */
  result: TResult | null;
  /** Last failure, or `null`. */
  error: JobError | null;
  /** Attempts made so far. */
  attempt: number;
  /** Per-job retry ceiling. */
  maxAttempts: number;
  /** Retry strategy. */
  backoff: BackoffStrategy;
  /** RFC 3339 enqueue timestamp. */
  enqueuedAt: string;
  /** Earliest runnable time, or `null`. */
  scheduledFor: string | null;
  /** RFC 3339 timestamp of the current/last attempt start, or `null`. */
  startedAt: string | null;
  /** RFC 3339 success timestamp, or `null`. */
  completedAt: string | null;
  /** RFC 3339 cancellation timestamp, or `null`. */
  cancelledAt: string | null;
  /** RFC 3339 dead-letter timestamp, or `null`. */
  deadLetteredAt: string | null;
  /** Worker currently holding the lease, or `null`. */
  currentWorkerId: string | null;
  /** RFC 3339 lease expiry, or `null`. */
  leaseExpiresAt: string | null;
  /** RFC 3339 next retry time, or `null`. */
  nextRetryAt: string | null;
  /** Completion webhook URL; omitted when not configured. */
  callbackUrl?: string;
  /** Webhook delivery state; omitted when not configured. */
  callbackStatus?: CallbackStatus;
  /** Number of webhook delivery attempts. */
  callbackAttempts: number;
  /** Last webhook delivery error; omitted when unset. */
  callbackLastError?: string;
  /** RFC 3339 webhook delivery timestamp; omitted when undelivered. */
  callbackDeliveredAt?: string;
  /** Per-attempt history, oldest first. */
  attempts: JobAttempt[];
  /** `true` when the job was returned from an idempotent replay. */
  isReplay: boolean;
}

/** Optional knobs shared by every enqueue call. */
export interface EnqueueOptions {
  /** Queue name. Defaults to the handler definition's queue or the client's `defaultQueue`. */
  queue?: string;
  /** `0` (lowest) to `9` (highest). Defaults to `5`. */
  priority?: number;
  /** Per-job retry ceiling. Defaults to `3`. */
  maxAttempts?: number;
  /** Retry strategy. Defaults to exponential (30s base, 1h cap). */
  backoff?: BackoffStrategy;
  /** Earliest runnable time as an ISO string or `Date`. */
  scheduledFor?: string | Date;
  /** Dedupe key scoped to the queue. Replays return the existing job. */
  idempotencyKey?: string;
  /** Completion webhook URL (absolute `http`/`https`, max 2048 chars). */
  callbackUrl?: string;
}

/**
 * Body accepted by `POST /jobs`.
 *
 * @typeParam TPayload - Shape of `payload`.
 */
export interface EnqueueJobInput<TPayload = unknown> extends EnqueueOptions {
  /** Handler name matched by workers. */
  handler: string;
  /** Opaque JSON payload passed to the handler. */
  payload: TPayload;
}

/**
 * Object form of an enqueue call using a {@link HandlerDefinition}.
 *
 * @typeParam TDefinition - Definition created with `defineHandler`.
 */
export interface DefinitionEnqueueInput<
  TDefinition extends HandlerDefinition<any, any, any, any> = HandlerDefinition<any, any, any, any>
> extends EnqueueOptions {
  /** Reusable handler definition. */
  handler: TDefinition;
  /** Payload satisfying the definition. */
  payload: DefinitionPayload<TDefinition>;
}

/**
 * Object form of a typed enqueue call. Known handler names constrain
 * `payload`; unknown names fall back to `TFallbackPayload`.
 */
export type TypedEnqueueInput<
  THandlers extends object,
  TName extends string,
  TFallbackPayload
> = EnqueueOptions & {
  handler: TName;
  payload: TName extends HandlerName<THandlers>
    ? HandlerPayload<THandlers, TName>
    : TFallbackPayload;
};

/** Payload type of a typed enqueue, with a fallback for unknown handlers. */
export type TypedEnqueuePayload<
  THandlers extends object,
  TName extends string,
  TFallbackPayload
> = TName extends HandlerName<THandlers> ? HandlerPayload<THandlers, TName> : TFallbackPayload;

/** Result type of a typed enqueue, with a fallback for unknown handlers. */
export type TypedEnqueueResult<
  THandlers extends object,
  TName extends string,
  TFallbackResult
> = TName extends HandlerName<THandlers> ? HandlerResult<THandlers, TName> : TFallbackResult;

/** Job returned by `POST /workers/:id/claim`. */
export interface JobClaim<TPayload = unknown> {
  /** Job ULID. */
  id: string;
  /** Queue the job belongs to. */
  queue: string;
  /** Handler name to execute. */
  handler: string;
  /** Storage status, normally `running`. */
  status: StorageJobStatus;
  /** 1-based attempt number. */
  attempt: number;
  /** Per-job retry ceiling. */
  maxAttempts: number;
  /** `0` to `9`. */
  priority: number;
  /** Job payload. */
  payload: TPayload;
  /** RFC 3339 lease expiry, or `null`. */
  leaseExpiresAt: string | null;
  /** RFC 3339 attempt start, or `null`. */
  startedAt: string | null;
  /** RFC 3339 enqueue timestamp. */
  enqueuedAt: string;
}

/** An in-flight lease shown on a worker record. */
export interface WorkerLease {
  /** Job ULID. */
  jobId: string;
  /** Handler name. */
  handler: string;
  /** Queue name. */
  queue: string;
  /** Attempt number. */
  attempt: number;
  /** RFC 3339 lease start, or an empty string. */
  leasedAt: string;
  /** RFC 3339 lease expiry, or an empty string. */
  leaseExpiresAt: string;
}

/** Worker lifecycle state stored in Postgres. */
export type WorkerState = 'active' | 'idle' | 'cordoned' | 'draining' | 'disconnected';

/** Worker representation returned by the `/workers` endpoints. */
export interface WorkerRecord {
  /** Ephemeral runtime id. */
  id: string;
  /** Hostname reported at registration. */
  hostname: string;
  /** OS process id. */
  pid: number;
  /** Worker version string. */
  version: string;
  /** Current lifecycle state. */
  state: WorkerState;
  /** RFC 3339 registration timestamp. */
  startedAt: string;
  /** RFC 3339 last heartbeat timestamp. */
  lastHeartbeatAt: string;
  /** Heartbeat cadence in seconds. */
  heartbeatIntervalSeconds: number;
  /** Queues this worker polls. */
  queues: string[];
  /** Handlers this worker advertises. */
  handlers: string[];
  /** Advertised concurrency limit. */
  maxConcurrency: number;
  /** Number of leases currently held. */
  inFlight: number;
  /** Lifetime completed attempts reported by this worker. */
  totalProcessed: number;
  /** Active leases. */
  leases: WorkerLease[];
}

/** Body accepted by `POST /workers/register`. */
export interface WorkerRegisterParams {
  /** Worker id. The API generates a ULID when omitted. */
  id?: string;
  /** Hostname. The API stores `external` when omitted. */
  hostname?: string;
  /** OS process id. */
  pid?: number;
  /** Worker version. The API stores `1.0.0` when omitted. */
  version?: string;
  /** Non-empty list of queues to poll. */
  queues: string[];
  /** Non-empty list of handler names this worker can run. */
  handlers: string[];
  /** Maximum concurrent jobs. Must be at least `1`. */
  maxConcurrency: number;
  /** Heartbeat cadence in seconds. Defaults to `10`. */
  heartbeatIntervalSeconds?: number;
}

/** Response from `POST /workers/:id/heartbeat`. */
export interface HeartbeatResponse {
  /** Worker id. */
  id: string;
  /** Current lifecycle state. */
  state: WorkerState;
  /** RFC 3339 heartbeat timestamp. */
  lastHeartbeatAt: string;
}

/** Body accepted by `POST /workers/:id/claim`. */
export interface ClaimParams {
  /** Queues to poll. Defaults to the worker's registered queues. */
  queues?: string[];
  /** Handlers to accept. Defaults to the worker's registered handlers. */
  handlers?: string[];
}

/** Body accepted by `POST /workers/:id/jobs/:jobId/fail`. */
export interface FailJobParams {
  /** Failure class. Defaults to `HandlerError`. */
  errorClass?: string;
  /** Failure message. Required by the API. */
  message: string;
  /** Stack trace captured by the handler. */
  stackTrace?: string;
  /** Skip remaining retries and dead-letter immediately. */
  permanent?: boolean;
}

/** Response from `POST /workers/:id/jobs/:jobId/complete`. */
export interface CompleteJobResponse {
  /** Always `true` on success. */
  completed: boolean;
  /** Job ULID. */
  jobId: string;
  /** Worker id. */
  workerId: string;
  /** Storage status after completion. */
  status: StorageJobStatus;
}

/** Response from `POST /workers/:id/jobs/:jobId/fail`. */
export interface FailJobResponse {
  /** Always `true` on success. */
  failed: boolean;
  /** Job ULID. */
  jobId: string;
  /** Worker id. */
  workerId: string;
  /** Storage status after the failure. */
  status: StorageJobStatus;
  /** Whether the failure was permanent. */
  permanent: boolean;
  /** `true` when the job was dead-lettered. */
  terminal: boolean;
}

/** Response from `POST /workers/:id/jobs/:jobId/heartbeat`. */
export interface RenewLeaseResponse {
  /** Always `true` on success. */
  renewed: boolean;
  /** Job ULID. */
  jobId: string;
  /** Worker id. */
  workerId: string;
  /** RFC 3339 new lease expiry. */
  leaseExpiresAt: string;
}

/** Response from `POST /workers/:id/deregister` and `DELETE /workers/:id`. */
export interface DeregisterWorkerResponse {
  /** Always `true` on success. */
  deregistered: boolean;
  /** Worker id. */
  workerId: string;
}

/** Execution context passed to every registered handler. */
export interface JobContext {
  /** Job ULID. */
  readonly jobId: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Queue name. */
  readonly queue: string;
  /** Handler name. */
  readonly handler: string;
  /** Aborted when the lease is lost, the worker drains, or the job is cancelled. */
  readonly signal: AbortSignal;
  /** Renews the job lease immediately. */
  extendLease(): Promise<RenewLeaseResponse>;
}

/** A job handler callback. */
export type HandlerFn<TPayload = unknown, TResult = unknown> = (
  job: JobClaim<TPayload>,
  ctx: JobContext
) => Promise<TResult> | TResult;

/** Configuration for {@link VeyraClient}. */
export interface VeyraClientConfig {
  /** API origin, e.g. `https://veyra.example.com`. Trailing slashes are trimmed. */
  baseUrl: string;
  /** Bearer API key with the scopes the calls require. */
  apiKey: string;
  /** Queue used when `enqueue` omits `queue`. Defaults to `default`. */
  defaultQueue?: string;
  /** Custom `fetch` implementation (tests, proxies, instrumented clients). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to `30000`. */
  timeoutMs?: number;
}

/** Options for {@link VeyraWorker}. */
export interface VeyraWorkerOptions {
  /** Queues to poll. At least one is required. */
  queues: string[];
  /** Handler names to advertise. Defaults to every registered handler. */
  handlers?: string[];
  /** Maximum concurrent jobs. Defaults to `5`. */
  concurrency?: number;
  /** Delay between empty polls in milliseconds. Defaults to `1000`. */
  pollIntervalMs?: number;
  /** Worker heartbeat cadence in milliseconds. Defaults to `10000`. */
  heartbeatIntervalMs?: number;
  /** In-flight lease renewal cadence in milliseconds. Defaults to `10000`. */
  leaseHeartbeatIntervalMs?: number;
  /** Hostname reported at registration. */
  hostname?: string;
  /** OS process id reported at registration. */
  pid?: number;
  /** Version reported at registration. Defaults to `0.1.0`. */
  version?: string;
  /** Explicit worker id. Defaults to a random `worker-*` id. */
  workerId?: string;
  /** Called when a job is claimed, before execution. */
  onJobStart?: (job: JobClaim) => void;
  /** Called after the API acknowledges completion. */
  onJobComplete?: (job: JobClaim, result: unknown) => void;
  /** Called after a handler throws or result validation fails. */
  onJobError?: (job: JobClaim, error: unknown) => void;
  /** Called for background errors (heartbeats, re-registration, reporting). */
  onError?: (error: unknown) => void;
}
