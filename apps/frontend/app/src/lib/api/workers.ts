import { apiFetch } from './client';
import type { Worker } from '@/lib/types';

export interface ListWorkersResponse {
  workers: Worker[];
}

export function listWorkers(
  signal?: AbortSignal,
): Promise<ListWorkersResponse> {
  return apiFetch<ListWorkersResponse>('/workers', { signal });
}
