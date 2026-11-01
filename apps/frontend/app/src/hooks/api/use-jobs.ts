// Hooks for the /jobs surface. Three:
//
//   useJobsList   — list + filters, polls every 5s by default
//   useJob        — single job, polls every 3s while it's in a non-terminal
//                   state (running/queued/scheduled) and stops polling once
//                   it terminates. Cheap to subscribe to.
//   useEnqueueJob — mutation; invalidates the list and stats on success.
//
// Polling intervals are conservative. The dashboard recommendation is "5s
// polling first, no websockets" — these hooks default to that and let
// pages override when they need faster feedback (Job Details).
import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import {
  cancelJob,
  enqueueJob,
  getJob,
  listJobs,
  type EnqueueJobInput,
  type ListJobsParams,
  type ListJobsResponse,
} from '@/lib/api/jobs';
import type { Job, JobStatus } from '@/lib/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';

const DEFAULT_LIST_POLL_MS = 5_000;
const ACTIVE_JOB_POLL_MS = 3_000;

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'succeeded',
  'failed',
  'dead-lettered',
  'cancelled',
]);

export function useJobsList(
  params: ListJobsParams,
  options?: Partial<UseQueryOptions<ListJobsResponse, ApiError>>,
) {
  return useQuery<ListJobsResponse, ApiError>({
    queryKey: queryKeys.jobs.list(params),
    queryFn: ({ signal }) => listJobs(params, signal),
    refetchInterval: DEFAULT_LIST_POLL_MS,
    // Filter changes should feel snappy; keep the previous page visible
    // while the next one loads instead of flashing a spinner.
    placeholderData: (prev) => prev,
    ...options,
  });
}

export function useJob(
  id: string | undefined,
  options?: Partial<UseQueryOptions<Job, ApiError>>,
) {
  return useQuery<Job, ApiError>({
    queryKey: id
      ? queryKeys.jobs.detail(id)
      : ['jobs', 'detail', '__pending__'],
    queryFn: ({ signal }) => getJob(id as string, signal),
    enabled: Boolean(id),
    // Poll faster while the job is alive, stop polling once it terminates.
    // The function form runs after each successful fetch, so the cadence
    // automatically slows when the worker reports a final status.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return ACTIVE_JOB_POLL_MS;
      return TERMINAL_STATUSES.has(data.status) ? false : ACTIVE_JOB_POLL_MS;
    },
    ...options,
  });
}

export function useEnqueueJob(
  options?: UseMutationOptions<Job, ApiError, EnqueueJobInput>,
) {
  const queryClient = useQueryClient();
  return useMutation<Job, ApiError, EnqueueJobInput>({
    mutationFn: (input) => enqueueJob(input),
    // TanStack Query v5 passes (data, variables, onMutateResult, context).
    // We forward every arg so caller-supplied onSuccess sees exactly what
    // it would see without our wrapping.
    onSuccess: (...args) => {
      // The new job changes both the list and the dashboard counts. We
      // invalidate at the resource roots so every cached filter combo and
      // the stats query refetch together.
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      return options?.onSuccess?.(...args);
    },
    ...options,
  });
}

/** Statuses from which Cancel is allowed (SPEC §6.2). */
export const CANCELLABLE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'queued',
  'scheduled',
  'running',
  'failed',
]);

export function useCancelJob(
  options?: UseMutationOptions<Job, ApiError, string>,
) {
  const queryClient = useQueryClient();
  return useMutation<Job, ApiError, string>({
    mutationFn: (id) => cancelJob(id),
    onSuccess: (job, ...rest) => {
      queryClient.setQueryData(queryKeys.jobs.detail(job.id), job);
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      return options?.onSuccess?.(job, ...rest);
    },
    ...options,
  });
}
