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

export function getWorker(id: string, signal?: AbortSignal): Promise<Worker> {
  return apiFetch<Worker>(`/workers/${encodeURIComponent(id)}`, { signal });
}

export const fetchWorker = getWorker;

export interface ReleaseWorkerLeaseResponse {
  released: boolean;
  workerId: string;
  jobId: string;
}

export function releaseWorkerLease(
  workerId: string,
  jobId: string,
): Promise<ReleaseWorkerLeaseResponse> {
  return apiFetch<ReleaseWorkerLeaseResponse>(
    `/workers/${encodeURIComponent(workerId)}/leases/${encodeURIComponent(jobId)}/release`,
    {
      method: 'POST',
    },
  );
}
