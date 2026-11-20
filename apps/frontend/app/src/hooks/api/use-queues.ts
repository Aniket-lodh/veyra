import { queryKeys } from './query-keys';
import { ApiError } from '@/lib/api/client';
import {
  pauseQueue,
  resumeQueue,
  type PauseQueueParams,
  type QueueStateResponse,
} from '@/lib/api/queues';
import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query';

export function usePauseQueue(
  options?: UseMutationOptions<QueueStateResponse, ApiError, PauseQueueParams>,
) {
  const queryClient = useQueryClient();
  return useMutation<QueueStateResponse, ApiError, PauseQueueParams>({
    mutationFn: (params) => pauseQueue(params),
    onSuccess: (data, ...rest) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workers.all });
      return options?.onSuccess?.(data, ...rest);
    },
    ...options,
  });
}

export function useResumeQueue(
  options?: UseMutationOptions<QueueStateResponse, ApiError, string>,
) {
  const queryClient = useQueryClient();
  return useMutation<QueueStateResponse, ApiError, string>({
    mutationFn: (queue) => resumeQueue(queue),
    onSuccess: (data, ...rest) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.workers.all });
      return options?.onSuccess?.(data, ...rest);
    },
    ...options,
  });
}
