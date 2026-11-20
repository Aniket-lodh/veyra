/**
 * Veyra TypeScript/Node SDK Type Definitions
 */

export type JobStatus =
  | 'queued'
  | 'scheduled'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead-lettered'
  | 'cancelled';

export type BackoffStrategy =
  | {
      kind: 'exponential';
      baseSeconds: number;
      capSeconds: number;
    }
  | {
      kind: 'fixed';
      seconds: number;
    };

export interface JobError {
  class: string;
  message: string;
  stackTrace?: string;
  occurredAt?: string;
}

export interface JobAttempt {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number | null;
  outcome?: string | null;
  errorClass?: string | null;
  errorMessage?: string | null;
}

export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  handler: string;
  queue: string;
  status: JobStatus;
  priority: number;
  idempotencyKey?: string | null;
  payload: TPayload;
  result?: TResult | null;
  error?: JobError | null;
  attempt: number;
  maxAttempts: number;
  backoff: BackoffStrategy;
  enqueuedAt: string;
  scheduledFor?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  deadLetteredAt?: string | null;
  currentWorkerId?: string | null;
  leaseExpiresAt?: string | null;
  nextRetryAt?: string | null;
  attempts: JobAttempt[];
  isReplay?: boolean;
}

export interface EnqueueJobInput<TPayload = unknown> {
  handler: string;
  queue: string;
  payload: TPayload;
  priority?: number;
  maxAttempts?: number;
  backoff?: BackoffStrategy;
  scheduledFor?: string | Date;
  idempotencyKey?: string;
}

export interface JobClaim<TPayload = unknown> {
  id: string;
  queue: string;
  handler: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  priority: number;
  payload: TPayload;
  leaseExpiresAt?: string | null;
  startedAt?: string | null;
  enqueuedAt: string;
}

export interface WorkerLease {
  jobId: string;
  handler: string;
  queue: string;
  attempt: number;
  leasedAt: string;
  leaseExpiresAt: string;
}

export type WorkerState = 'active' | 'cordoned' | 'draining' | 'disconnected';

export interface WorkerRecord {
  id: string;
  hostname: string;
  pid: number;
  version: string;
  state: WorkerState;
  startedAt: string;
  lastHeartbeatAt: string;
  heartbeatIntervalSeconds: number;
  queues: string[];
  handlers: string[];
  maxConcurrency: number;
  inFlight: number;
  totalProcessed: number;
  leases: WorkerLease[];
}

export interface WorkerRegisterParams {
  id?: string;
  hostname?: string;
  pid?: number;
  version?: string;
  queues: string[];
  handlers: string[];
  maxConcurrency: number;
  heartbeatIntervalSeconds?: number;
}

export interface HeartbeatResponse {
  id: string;
  state: string;
  lastHeartbeatAt: string;
}

export interface ClaimParams {
  queues?: string[];
  handlers?: string[];
}

export interface FailJobParams {
  errorClass?: string;
  message: string;
  stackTrace?: string;
  permanent?: boolean;
}

export interface CompleteJobResponse {
  completed: boolean;
  jobId: string;
  workerId: string;
  status: string;
}

export interface FailJobResponse {
  failed: boolean;
  jobId: string;
  workerId: string;
  status: string;
  permanent: boolean;
  terminal: boolean;
}

export interface RenewLeaseResponse {
  renewed: boolean;
  jobId: string;
  workerId: string;
  leaseExpiresAt: string;
}

export interface JobContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly queue: string;
  readonly handler: string;
  readonly signal: AbortSignal;
  extendLease(): Promise<RenewLeaseResponse>;
}

export type HandlerFn<TPayload = unknown, TResult = unknown> = (
  job: JobClaim<TPayload>,
  ctx: JobContext
) => Promise<TResult> | TResult;

export interface VeyraClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultQueue?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface VeyraWorkerOptions {
  queues: string[];
  handlers?: string[];
  concurrency?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseHeartbeatIntervalMs?: number;
  hostname?: string;
  pid?: number;
  version?: string;
  workerId?: string;
  onJobStart?: (job: JobClaim) => void;
  onJobComplete?: (job: JobClaim, result: unknown) => void;
  onJobError?: (job: JobClaim, error: unknown) => void;
  onError?: (error: unknown) => void;
}
