import type { JobStatus } from '@/components/ui/status-badge';

export type { JobStatus };

export const KNOWN_HANDLERS = ['http_request', 'send_email', 'noop'] as const;
export type KnownHandler = (typeof KNOWN_HANDLERS)[number];

export type BackoffStrategy =
  | { kind: 'exponential'; baseSeconds: number; capSeconds: number }
  | { kind: 'fixed'; seconds: number };

export type AttemptOutcome =
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'lease-lost';

export interface JobAttempt {
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: AttemptOutcome | null;
  errorClass: string | null;
  errorMessage: string | null;
}

export interface JobError {
  class: string;
  message: string;
  stackTrace: string;
  occurredAt: string;
}

export interface Job {
  id: string;
  handler: string;
  queue: string;
  status: JobStatus;
  priority: number;
  idempotencyKey: string | null;

  payload: unknown;
  result: unknown | null;
  error: JobError | null;

  attempt: number;
  maxAttempts: number;
  backoff: BackoffStrategy;

  enqueuedAt: string;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  deadLetteredAt: string | null;

  currentWorkerId: string | null;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;

  attempts: JobAttempt[];
}

export type WorkerState = 'active' | 'idle' | 'draining' | 'disconnected';

export interface WorkerLease {
  jobId: string;
  handler: string;
  queue: string;
  attempt: number;
  leasedAt: string;
  leaseExpiresAt: string;
}

export interface Worker {
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
