import { apiFetch } from './client';
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

export function enqueueJob(
  input: EnqueueJobInput,
  signal?: AbortSignal,
): Promise<Job> {
  return apiFetch<Job>('/jobs', { method: 'POST', body: input, signal });
}

export function cancelJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    signal,
  });
}
