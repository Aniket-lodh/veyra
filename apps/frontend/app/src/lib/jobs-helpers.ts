import type { QueueStatsResponse } from './api/stats';
import type { JobStatus } from './types';

export type JobFilterTab =
  | 'all'
  | 'active'
  | 'queued'
  | 'running'
  | 'scheduled'
  | 'failed'
  | 'dead-lettered'
  | 'succeeded'
  | 'cancelled';

export interface JobsMetrics {
  total: number;
  active: number;
  queued: number;
  running: number;
  scheduled: number;
  failed: number;
  deadLettered: number;
  succeeded: number;
  cancelled: number;
}

export const CANCELLABLE_STATUS_SET: ReadonlySet<JobStatus> =
  new Set<JobStatus>(['queued', 'scheduled', 'running', 'failed']);

/**
 * Checks whether a job can be cancelled according to SPEC §6.
 */
export function isJobCancellable(status: JobStatus): boolean {
  return CANCELLABLE_STATUS_SET.has(status);
}

export const RETRYABLE_STATUS_SET: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'failed',
  'dead-lettered',
  'cancelled',
]);

/**
 * Checks whether a job can be retried according to SPEC §8.1.
 * Only failed, dead_lettered, or cancelled jobs can be retried.
 */
export function isJobRetryable(status: JobStatus): boolean {
  return RETRYABLE_STATUS_SET.has(status);
}

/**
 * Derives queue KPI metrics from QueueStatsResponse totals (or fallback).
 */
export function computeJobsMetrics(
  stats?: QueueStatsResponse,
  fallbackTotal: number = 0,
): JobsMetrics {
  if (!stats?.totals) {
    return {
      total: fallbackTotal,
      active: 0,
      queued: 0,
      running: 0,
      scheduled: 0,
      failed: 0,
      deadLettered: 0,
      succeeded: 0,
      cancelled: 0,
    };
  }

  const {
    queued,
    scheduled,
    running,
    succeeded,
    failed,
    deadLettered,
    cancelled,
  } = stats.totals;

  const total =
    queued +
    scheduled +
    running +
    succeeded +
    failed +
    deadLettered +
    cancelled;
  const active = queued + scheduled + running;

  return {
    total,
    active,
    queued,
    running,
    scheduled,
    failed,
    deadLettered,
    succeeded,
    cancelled,
  };
}

/**
 * Maps a quick filter tab to its corresponding JobStatus array for the API query.
 */
export function mapTabToStatuses(tab: JobFilterTab): JobStatus[] | undefined {
  switch (tab) {
    case 'all':
      return undefined;
    case 'active':
      return ['queued', 'running', 'scheduled'];
    case 'queued':
      return ['queued'];
    case 'running':
      return ['running'];
    case 'scheduled':
      return ['scheduled'];
    case 'failed':
      return ['failed'];
    case 'dead-lettered':
      return ['dead-lettered'];
    case 'succeeded':
      return ['succeeded'];
    case 'cancelled':
      return ['cancelled'];
  }
}

/**
 * Infers the active JobFilterTab from an array of active statuses from URL search params.
 */
export function inferTabFromStatuses(statuses: JobStatus[]): JobFilterTab {
  if (statuses.length === 0) return 'all';

  if (statuses.length === 3) {
    const set = new Set(statuses);
    if (set.has('queued') && set.has('running') && set.has('scheduled')) {
      return 'active';
    }
  }

  if (statuses.length === 1) {
    const single = statuses[0];
    if (
      single === 'queued' ||
      single === 'running' ||
      single === 'scheduled' ||
      single === 'failed' ||
      single === 'dead-lettered' ||
      single === 'succeeded' ||
      single === 'cancelled'
    ) {
      return single;
    }
  }

  return 'all';
}

/**
 * Extracts and sorts unique queue names from stats and current selection.
 */
export function extractQueueOptions(
  queuesFromStats?: Array<{ name: string }>,
  selectedQueue?: string,
): string[] {
  const set = new Set<string>(['default']);
  for (const q of queuesFromStats ?? []) {
    if (q.name?.trim()) set.add(q.name.trim());
  }
  if (selectedQueue && selectedQueue.trim()) {
    set.add(selectedQueue.trim());
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Returns formatted priority badge text and tone.
 */
export function getPriorityMeta(priority: number): {
  label: string;
  tone: 'high' | 'normal' | 'low';
} {
  if (priority >= 8) {
    return { label: `P${priority} High`, tone: 'high' };
  }
  if (priority >= 4) {
    return { label: `P${priority}`, tone: 'normal' };
  }
  return { label: `P${priority} Low`, tone: 'low' };
}

/**
 * Pretty-prints or safely excerpts a JSON object or string for display.
 */
export function formatPayloadSummary(
  payload: unknown,
  maxLength: number = 80,
): string {
  if (payload === null || payload === undefined) return '—';
  try {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '…';
  } catch {
    return '—';
  }
}

/**
 * Formats attempt ratio string e.g. "1 / 3".
 */
export function formatAttemptRatio(
  attempt: number,
  maxAttempts: number,
): string {
  return `${attempt} / ${maxAttempts}`;
}

/**
 * Validates JSON string for Quick Enqueue payload.
 */
export function validateJsonString(raw: string): {
  valid: boolean;
  parsed?: unknown;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'Payload JSON is required' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) {
      return { valid: false, error: 'Payload must be a JSON object or array' };
    }
    return { valid: true, parsed };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid JSON syntax',
    };
  }
}
