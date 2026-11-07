import { notifyAuthRequired } from '@/lib/auth/auth-events';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the global 401 → sign-in redirect (login/status calls). */
  skipAuthRedirect?: boolean;
}

export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = path + buildQueryString(options.query);

  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    signal: options.signal,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (response.status === 401 && !options.skipAuthRedirect) {
    notifyAuthRequired();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  let parsed: unknown = undefined;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (response.ok) {
        throw new Error(`api: non-JSON success response from ${url}`);
      }
    }
  }

  if (!response.ok) {
    const message = extractErrorMessage(parsed) ?? response.statusText;
    throw new ApiError(response.status, message, parsed);
  }

  return parsed as T;
}

function buildQueryString(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null || v === '') continue;
        params.append(key, String(v));
      }
    } else {
      const s = String(value);
      if (s.length === 0) continue;
      params.append(key, s);
    }
  }
  const out = params.toString();
  return out.length > 0 ? `?${out}` : '';
}

function extractErrorMessage(body: unknown): string | undefined {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error;
  }
  return undefined;
}
