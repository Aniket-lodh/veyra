import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import { listWorkers, type ListWorkersResponse } from '@/lib/api/workers';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

const DEFAULT_WORKERS_POLL_MS = 5_000;

/**
 * useWorkers — the operator dashboard's primary read for the Workers
 * View. Polls every 5 seconds; the response includes the currently held
 * leases for each worker, joined in-process by the api.
 */
export function useWorkers(
  options?: Partial<UseQueryOptions<ListWorkersResponse, ApiError>>,
) {
  return useQuery<ListWorkersResponse, ApiError>({
    queryKey: queryKeys.workers.all,
    queryFn: ({ signal }) => listWorkers(signal),
    refetchInterval: DEFAULT_WORKERS_POLL_MS,
    ...options,
  });
}
