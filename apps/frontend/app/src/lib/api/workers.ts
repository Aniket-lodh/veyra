import { apiFetch } from './client';
import type { Worker } from '@/lib/types';

export interface ListWorkersResponse {
  workers: Worker[];
}

/**
 * GET /workers — the full roster, no pagination. A single-VPS deployment
 * has tens of workers at most; when that stops being true the backend
 * will add limit/offset and this signature grows to match.
 *
 * The `leases` array on each worker is joined in-process from the jobs
 * table (running leases for that worker id).
 */
export function listWorkers(
  signal?: AbortSignal,
): Promise<ListWorkersResponse> {
  return apiFetch<ListWorkersResponse>('/workers', { signal });
}
