import { apiFetch, apiFetchWithMeta } from './client';
import type { BackoffStrategy, Job, JobStatus } from '@/lib/types';

export interface ListJobsParams {
  limit?: number;
  offset?: number;
  statuses?: JobStatus[];
  queues?: string[];
  handlers?: string[];
  search?: string;
}

export interface ListJobsResponse {
  jobs: Job[];
  totalCount: number;
  limit: number;
  offset: number;
}

export function listJobs(
  params: ListJobsParams,
  signal?: AbortSignal,
): Promise<ListJobsResponse> {
  return apiFetch<ListJobsResponse>('/jobs', {
    query: {
      limit: params.limit,
      offset: params.offset,
      status: params.statuses,
      queue: params.queues,
      handler: params.handlers,
      search: params.search,
    },
    signal,
  });
}

export function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}`, { signal });
}

export interface EnqueueJobInput {
  handler: string;
  queue: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  backoff?: BackoffStrategy;
  scheduledFor?: string;
  idempotencyKey?: string;
}

export interface EnqueuedJob extends Job {
  isReplay?: boolean;
}

export async function enqueueJob(
  input: EnqueueJobInput,
  signal?: AbortSignal,
): Promise<EnqueuedJob> {
  const headers: Record<string, string> = {};
  if (input.idempotencyKey && input.idempotencyKey.trim() !== '') {
    headers['Idempotency-Key'] = input.idempotencyKey.trim();
  }

  const res = await apiFetchWithMeta<Job>('/jobs', {
    method: 'POST',
    headers,
    body: input,
    signal,
  });

  const isReplay = res.headers.get('idempotent-replay') === 'true';
  return Object.assign(res.data, { isReplay });
}

export function cancelJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    signal,
  });
}

export function retryJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    signal,
  });
}

export interface ReplayDlqParams {
  queue?: string;
  handler?: string;
  limit?: number;
}

export interface ReplayDlqResponse {
  replayedCount: number;
  jobIds: string[];
}

export function replayDlq(
  params?: ReplayDlqParams,
  signal?: AbortSignal,
): Promise<ReplayDlqResponse> {
  return apiFetch<ReplayDlqResponse>('/jobs/dlq/replay', {
    method: 'POST',
    body: params,
    signal,
  });
}
