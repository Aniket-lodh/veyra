import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import { getQueueStats, type QueueStatsResponse } from '@/lib/api/stats';
import { useLiveRefetchInterval } from '@/lib/live/use-live-refetch-interval';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

export function useQueueStats(
  options?: Partial<UseQueryOptions<QueueStatsResponse, ApiError>>,
) {
  const liveRefetch = useLiveRefetchInterval();
  return useQuery<QueueStatsResponse, ApiError>({
    queryKey: queryKeys.stats.all,
    queryFn: ({ signal }) => getQueueStats(signal),
    refetchInterval: liveRefetch,
    ...options,
  });
}
