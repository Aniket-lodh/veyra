import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import { listWorkers, type ListWorkersResponse } from '@/lib/api/workers';
import { useLiveRefetchInterval } from '@/lib/live/use-live-refetch-interval';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

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
