// Thin fetch wrapper for the Veyra api. Single place that knows how to talk
// to the backend so every hook above it can focus on shape and caching.
//
// Design choices that are deliberate (and worth keeping when extending):
//
//   - Relative URLs only. The Vite dev proxy and the prod nginx both route
//     /jobs, /queue, /workers, /health to the api on the same origin. Hard
//     coding a base URL would force us to maintain two builds.
//
//   - One ApiError class. Every non-2xx response throws the same shape so
//     callers branch on `status` rather than parsing arbitrary messages.
//
//   - No request retries here. TanStack Query owns retry policy; doubling
//     up would multiply traffic and confuse cache invalidation timing.
//
//   - JSON in / JSON out. Endpoints that diverge from this convention will
//     have to call `fetch` directly; the cost is forcing that escape hatch
//     to be deliberate, which is the right friction.

/**
 * ApiError is thrown by `apiFetch` whenever the response status is not 2xx.
 * The `body` field carries whatever the api returned (often `{ error: "…" }`
 * but callers should not assume that shape) so error UIs can surface the
 * backend's own message without re-stringifying status codes.
 */
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
  /**
   * URL-encoded query parameters. Arrays produce repeated keys, matching
   * the api's repeated-query convention (e.g. ?status=succeeded&status=failed).
   * Undefined values are skipped so callers can pass optional filters
   * uniformly without inline guards.
   */
  query?: Record<string, string | number | boolean | string[] | undefined>;
  /** Request body. Will be JSON-serialised. */
  body?: unknown;
  /** Forwarded to fetch's AbortSignal — TanStack Query passes one per query. */
  signal?: AbortSignal;
}

/**
 * apiFetch is the one fetch path. Returns the parsed JSON body typed as `T`;
 * throws ApiError on non-2xx; throws a generic Error on network failure or
 * malformed JSON.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = path + buildQueryString(options.query);

  const init: RequestInit = {
    method: options.method ?? 'GET',
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

  // 204 No Content (none today, but worth handling now).
  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  let parsed: unknown = undefined;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Non-JSON body. If the response was successful we still need to
      // surface this as a programming error — the api always returns JSON.
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

/**
 * buildQueryString converts the typed query object into the URL suffix.
 * Empty input yields "" (no `?`). Array values produce repeated keys
 * (`status=a&status=b`), matching the api's filter convention.
 */
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
