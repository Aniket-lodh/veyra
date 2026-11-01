// because the dashboard previously rendered hardcoded values; the API
// shape is defined here and matches the response contract documented in
// apps/api/internal/stats/handler.go.
import { apiFetch } from './client';

/**
 * StatusTotals is the global count of jobs in each API status (the
 * 7-value vocabulary: `queued` = "queued AND due", `scheduled` = "queued
 * AND future", and the rest map 1:1 to storage).
 */
export interface StatusTotals {
  queued: number;
  scheduled: number;
  running: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  cancelled: number;
}

/**
 * QueueAggregate is the per-queue snapshot. The 24h windows look back
 * exactly 24 hours from now, anchored to the terminal transition
 * timestamp (completed_at / dead_lettered_at).
 *
 * jobsPerMinute and percentile latencies are deliberately NOT included
 * yet — they require a time-series store the backend doesn't have. The
 * dashboard should render them as `null`/`—` until they're added.
 */
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

/**
 * GET /queue/stats — the dashboard's primary read. Cheap (two aggregate
 * queries) so polling at a few-second cadence is reasonable.
 */
export function getQueueStats(
  signal?: AbortSignal,
): Promise<QueueStatsResponse> {
  return apiFetch<QueueStatsResponse>('/queue/stats', { signal });
}
