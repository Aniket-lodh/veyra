import { apiFetch } from './client';

export interface StatusTotals {
  queued: number;
  scheduled: number;
  running: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  cancelled: number;
}

export interface QueueAggregate {
  name: string;
  depth: number;
  inFlight: number;
  succeeded24h: number;
  failed24h: number;
  deadLettered24h: number;
}

export interface QueueStatsResponse {
  totals: StatusTotals;
  queues: QueueAggregate[];
}

export function getQueueStats(
  signal?: AbortSignal,
): Promise<QueueStatsResponse> {
  return apiFetch<QueueStatsResponse>('/queue/stats', { signal });
}
