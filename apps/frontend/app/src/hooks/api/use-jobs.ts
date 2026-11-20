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
import { useLiveRefetchInterval } from '@/lib/live/use-live-refetch-interval';
import type { Job, JobStatus } from '@/lib/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';

export function useJobsList(
  params: ListJobsParams,
  options?: Partial<UseQueryOptions<ListJobsResponse, ApiError>>,
) {
  const liveRefetch = useLiveRefetchInterval();
  return useQuery<ListJobsResponse, ApiError>({
    queryKey: queryKeys.jobs.list(params),
    queryFn: ({ signal }) => listJobs(params, signal),
    placeholderData: (prev) => prev,
    refetchInterval: liveRefetch,
    ...options,
  });
}

export function useJob(
  id: string | undefined,
  options?: Partial<UseQueryOptions<Job, ApiError>>,
) {
  const liveRefetch = useLiveRefetchInterval();
  return useQuery<Job, ApiError>({
    queryKey: id
      ? queryKeys.jobs.detail(id)
      : ['jobs', 'detail', '__pending__'],
    queryFn: ({ signal }) => getJob(id as string, signal),
    enabled: Boolean(id),
    // Live stream invalidates; 60s safety refetch only while paused.
    refetchInterval: liveRefetch,
    ...options,
  });
}

export function useEnqueueJob(
  options?: UseMutationOptions<Job, ApiError, EnqueueJobInput>,
) {
  const queryClient = useQueryClient();
  return useMutation<Job, ApiError, EnqueueJobInput>({
    mutationFn: (input) => enqueueJob(input),
    onSuccess: (...args) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      return options?.onSuccess?.(...args);
    },
    ...options,
  });
}

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
