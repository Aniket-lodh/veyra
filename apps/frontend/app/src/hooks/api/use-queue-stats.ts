import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import { getQueueStats, type QueueStatsResponse } from '@/lib/api/stats';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

const DEFAULT_STATS_POLL_MS = 5_000;

/**
 * useQueueStats — drives the dashboard's totals + per-queue cards. Cheap
 * to call (two aggregate selects on the backend), so a 5-second poll is
 * fine. Mutations elsewhere (e.g. enqueue) invalidate this key, so the
 * dashboard updates without waiting for the next tick.
 */
export function useQueueStats(
  options?: Partial<UseQueryOptions<QueueStatsResponse, ApiError>>,
) {
  return useQuery<QueueStatsResponse, ApiError>({
    queryKey: queryKeys.stats.all,
    queryFn: ({ signal }) => getQueueStats(signal),
    refetchInterval: DEFAULT_STATS_POLL_MS,
    ...options,
  });
}
