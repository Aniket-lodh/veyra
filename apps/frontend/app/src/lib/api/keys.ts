import { apiFetch } from '@/lib/api/client';

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt?: string | null;
};

export type CreatedApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  secret: string;
};

export function listApiKeys(
  signal?: AbortSignal,
): Promise<{ keys: ApiKeyRow[] }> {
  return apiFetch<{ keys: ApiKeyRow[] }>('/api-keys', { signal });
}

export function createApiKey(input: {
  name: string;
  expiresAt?: string | null;
  scopes?: string[];
}): Promise<CreatedApiKey> {
  return apiFetch<CreatedApiKey>('/api-keys', {
    method: 'POST',
    body: {
      name: input.name,
      scopes: input.scopes ?? ['*'],
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export function revokeApiKey(id: string): Promise<void> {
  return apiFetch<void>(`/api-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
