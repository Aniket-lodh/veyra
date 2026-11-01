import { apiFetch } from './client';
import type { BackoffStrategy, Job, JobStatus } from '@/lib/types';

/**
 * Filters for GET /jobs. Every field is optional; an undefined or empty
 * value means "no constraint on this field." `statuses` accepts the
 * 7-value API vocabulary (including the derived `scheduled` and the
 * hyphenated `dead-lettered`); the backend translates these to its
 * 6-value storage enum.
 */
export interface ListJobsParams {
  limit?: number;
  offset?: number;
  statuses?: JobStatus[];
  queues?: string[];
  /** Exact handler-name match, multiple OR'd. Use to isolate one workload
   *  (e.g. ['http_request']). Distinct from `search`, which is a prefix. */
  handlers?: string[];
  /** Case-insensitive prefix match on job id and handler name. */
  search?: string;
}

export interface ListJobsResponse {
  jobs: Job[];
  totalCount: number;
  limit: number;
  offset: number;
}

/**
 * GET /jobs — paginated, filterable listing. The backend caps `limit` at
 * 200; values above are silently clamped server-side, so callers don't
 * need to validate.
 */
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

/**
 * GET /jobs/:id — single job with its full attempt history populated.
 * 404 surfaces as ApiError(status=404); the caller (a useQuery hook)
 * decides whether to render "not found" or rethrow.
 */
export function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}`, { signal });
}

/**
 * POST /jobs — enqueue a job. The backend is idempotent on
 * (queue, idempotencyKey): re-posting with the same key returns the
 * existing row instead of creating a duplicate.
 */
export interface EnqueueJobInput {
  handler: string;
  queue: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  backoff?: BackoffStrategy;
  /** ISO 8601 string. When in the future, the job lands as `scheduled`. */
  scheduledFor?: string;
  idempotencyKey?: string;
}

export function enqueueJob(
  input: EnqueueJobInput,
  signal?: AbortSignal,
): Promise<Job> {
  return apiFetch<Job>('/jobs', { method: 'POST', body: input, signal });
}

/**
 * POST /jobs/:id/cancel — cooperative cancel (SPEC §6).
 * 200 with the job (idempotent if already cancelled).
 * 404 unknown id; 409 succeeded / dead-lettered.
 */
export function cancelJob(id: string, signal?: AbortSignal): Promise<Job> {
  return apiFetch<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    signal,
  });
}
