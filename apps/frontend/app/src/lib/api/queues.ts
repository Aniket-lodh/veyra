import { apiFetch } from './client';

export interface QueueStateResponse {
  queue: string;
  paused: boolean;
  pausedAt?: string | null;
  pausedReason?: string | null;
  updatedAt: string;
}

export interface PauseQueueParams {
  queue: string;
  reason?: string;
}

export function pauseQueue(
  params: PauseQueueParams,
): Promise<QueueStateResponse> {
  const encoded = encodeURIComponent(params.queue.trim());
  return apiFetch<QueueStateResponse>(`/queues/${encoded}/pause`, {
    method: 'POST',
    body: params.reason ? { reason: params.reason } : undefined,
  });
}

export function resumeQueue(queue: string): Promise<QueueStateResponse> {
  const encoded = encodeURIComponent(queue.trim());
  return apiFetch<QueueStateResponse>(`/queues/${encoded}/resume`, {
    method: 'POST',
  });
}
