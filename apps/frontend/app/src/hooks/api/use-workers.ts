import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import {
  getWorker,
  listWorkers,
  releaseWorkerLease,
  type ListWorkersResponse,
  type ReleaseWorkerLeaseResponse,
} from '@/lib/api/workers';
import { useLiveRefetchInterval } from '@/lib/live/use-live-refetch-interval';
import type { Worker } from '@/lib/types';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';

export function useWorkers(
  options?: Partial<UseQueryOptions<ListWorkersResponse, ApiError>>,
) {
  const liveRefetch = useLiveRefetchInterval();
  return useQuery<ListWorkersResponse, ApiError>({
    queryKey: queryKeys.workers.all,
    queryFn: ({ signal }) => listWorkers(signal),
    refetchInterval: liveRefetch,
    ...options,
  });
}

export function useWorker(
  id: string | undefined,
  options?: Partial<UseQueryOptions<Worker, ApiError>>,
) {
  const liveRefetch = useLiveRefetchInterval();
  return useQuery<Worker, ApiError>({
    queryKey: id
      ? queryKeys.workers.detail(id)
      : ['workers', 'detail', '__pending__'],
    queryFn: ({ signal }) => getWorker(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: liveRefetch,
    ...options,
  });
}

export function useReleaseWorkerLease(
  options?: UseMutationOptions<
    ReleaseWorkerLeaseResponse,
    ApiError,
    { workerId: string; jobId: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    ReleaseWorkerLeaseResponse,
    ApiError,
    { workerId: string; jobId: string }
  >({
    mutationFn: ({ workerId, jobId }) => releaseWorkerLease(workerId, jobId),
    onSuccess: (data, variables, ...rest) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workers.all });
      queryClient.invalidateQueries({
        queryKey: queryKeys.workers.detail(variables.workerId),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      return options?.onSuccess?.(data, variables, ...rest);
    },
    ...options,
  });
}
