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

export function drainWorker(id: string): Promise<Worker> {
  return apiFetch<Worker>(`/workers/${encodeURIComponent(id)}/drain`, {
    method: 'POST',
  });
}

export function cordonWorker(id: string): Promise<Worker> {
  return apiFetch<Worker>(`/workers/${encodeURIComponent(id)}/cordon`, {
    method: 'POST',
  });
}

export function resumeWorker(id: string): Promise<Worker> {
  return apiFetch<Worker>(`/workers/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
  });
}

export interface DeregisterWorkerResponse {
  deregistered: boolean;
  workerId: string;
}

export function deregisterWorker(
  id: string,
): Promise<DeregisterWorkerResponse> {
  return apiFetch<DeregisterWorkerResponse>(
    `/workers/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}
