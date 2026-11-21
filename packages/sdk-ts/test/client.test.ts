import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import util from 'node:util';
import {
  LeaseLostError,
  VeyraApiError,
  VeyraAuthError,
  VeyraClient,
  VeyraConflictError,
  VeyraError,
  VeyraNetworkError,
  VeyraNotFoundError,
  VeyraRateLimitError,
  VeyraTimeoutError,
  VeyraValidationError,
} from '../dist/index.js';

describe('VeyraClient', () => {
  it('throws on missing or invalid baseUrl', () => {
    assert.throws(
      () => new VeyraClient({ baseUrl: '', apiKey: 'veyra_test' }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'not-a-url', apiKey: 'veyra_test' }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'ftp://localhost:8080', apiKey: 'veyra_test' }),
      VeyraValidationError
    );
  });

  it('throws on missing, whitespace, or CRLF apiKey', () => {
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: '' }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: '   ' }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'key\r\nBad' }),
      VeyraValidationError
    );
  });

  it('validates timeoutMs and maxRetries', () => {
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'key', timeoutMs: -1 }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'key', timeoutMs: NaN }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'key', maxRetries: -1 }),
      VeyraValidationError
    );
    assert.throws(
      () => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'key', maxRetries: 25 }),
      VeyraValidationError
    );
  });

  it('redacts apiKey from JSON.stringify, util.inspect, and Object.keys', () => {
    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_super_secret_value',
      defaultQueue: 'critical',
    });

    const json = JSON.stringify(client);
    assert.ok(!json.includes('veyra_super_secret_value'));
    assert.deepEqual(JSON.parse(json), {
      baseUrl: 'http://localhost:8080',
      defaultQueue: 'critical',
      hasApiKey: true,
    });

    const inspected = util.inspect(client);
    assert.ok(!inspected.includes('veyra_super_secret_value'));

    assert.ok(!Object.keys(client).includes('apiKey'));
    assert.ok(!Object.getOwnPropertyNames(client).includes('apiKey'));
  });

  it('normalizes baseUrl and sets defaultQueue', () => {
    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080///',
      apiKey: 'veyra_test_key',
      defaultQueue: 'critical',
    });
    assert.equal(client.baseUrl, 'http://localhost:8080');
    assert.equal(client.defaultQueue, 'critical');
  });

  it('enqueues a job with correct headers and payload serialization', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          id: 'job_123',
          handler: 'send_email',
          queue: 'default',
          status: 'queued',
          priority: 5,
          payload: { to: 'user@example.com' },
          attempt: 0,
          maxAttempts: 3,
          backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
          enqueuedAt: '2026-11-20T12:00:00Z',
          attempts: [],
        }),
        {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
            'Idempotent-Replay': 'true',
            'X-Request-Id': 'req_xyz_123',
          },
        }
      );
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_secret_123',
      fetch: mockFetch,
    });

    const scheduledDate = new Date('2026-11-21T00:00:00Z');
    const job = await client.enqueue({
      handler: 'send_email',
      queue: 'default',
      payload: { to: 'user@example.com' },
      priority: 8,
      maxAttempts: 5,
      scheduledFor: scheduledDate,
      idempotencyKey: 'idemp_abc',
      callbackUrl: 'https://webhook.site/abc',
    });

    assert.equal(capturedUrl, 'http://localhost:8080/jobs');
    assert.equal(capturedInit?.method, 'POST');

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer veyra_secret_123');
    assert.equal(headers['Idempotency-Key'], 'idemp_abc');

    const body = JSON.parse(capturedInit?.body as string);
    assert.equal(body.handler, 'send_email');
    assert.equal(body.queue, 'default');
    assert.equal(body.priority, 8);
    assert.equal(body.maxAttempts, 5);
    assert.equal(body.scheduledFor, scheduledDate.toISOString());
    assert.equal(body.idempotencyKey, 'idemp_abc');
    assert.equal(body.callbackUrl, 'https://webhook.site/abc');

    assert.equal(job.id, 'job_123');
    assert.equal(job.isReplay, true);
  });

  it('rejects non-JSON-serializable payload with VeyraValidationError', async () => {
    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
    });

    await assert.rejects(
      () =>
        client.enqueue({
          handler: 'test',
          payload: { big: BigInt(9007199254740991) },
        }),
      (err: unknown) => {
        assert.ok(err instanceof VeyraValidationError);
        assert.match(err.message, /JSON-serializable/);
        return true;
      }
    );
  });

  it('rejects invalid callbackUrl scheme or excessive length', async () => {
    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
    });

    await assert.rejects(
      () =>
        client.enqueue({
          handler: 'test',
          payload: { ok: true },
          callbackUrl: 'ftp://example.com/webhook',
        }),
      VeyraValidationError
    );

    await assert.rejects(
      () =>
        client.enqueue({
          handler: 'test',
          payload: { ok: true },
          callbackUrl: 'https://example.com/' + 'a'.repeat(2100),
        }),
      VeyraValidationError
    );
  });

  it('translates 401 and 403 to VeyraAuthError with requestId', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'invalid api key' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req_auth_fail_1',
        },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_bad_key',
      fetch: mockFetch,
    });

    await assert.rejects(
      async () => client.getJob('job_1'),
      (err: unknown) => {
        assert.ok(err instanceof VeyraAuthError);
        assert.equal(err.status, 401);
        assert.equal(err.requestId, 'req_auth_fail_1');
        assert.equal(err.retryable, false);
        assert.match(err.message, /invalid api key/);
        return true;
      }
    );
  });

  it('translates 404 to VeyraNotFoundError', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'job not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      fetch: mockFetch,
    });

    await assert.rejects(
      async () => client.getJob('job_nonexistent'),
      (err: unknown) => {
        assert.ok(err instanceof VeyraNotFoundError);
        assert.equal(err.status, 404);
        assert.equal(err.retryable, false);
        return true;
      }
    );
  });

  it('translates 409 to VeyraConflictError or LeaseLostError', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'lease lost or expired' }), {
        status: 409,
        statusText: 'Conflict',
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      fetch: mockFetch,
    });

    await assert.rejects(
      async () => client.renewJobLease('w_1', 'j_1'),
      (err: unknown) => {
        assert.ok(err instanceof LeaseLostError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'LEASE_LOST');
        return true;
      }
    );
  });

  it('translates 429 to VeyraRateLimitError and parses Retry-After header', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '5',
          'X-Request-Id': 'req_429',
        },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      maxRetries: 0,
      fetch: mockFetch,
    });

    await assert.rejects(
      async () => client.getJob('job_1'),
      (err: unknown) => {
        assert.ok(err instanceof VeyraRateLimitError);
        assert.equal(err.status, 429);
        assert.equal(err.retryAfterMs, 5000);
        assert.equal(err.requestId, 'req_429');
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  it('handles Nginx HTML 502 without dumping raw HTML', async () => {
    const mockFetch = (async () => {
      return new Response(
        '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>nginx/1.24.0</p></body></html>',
        {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/html' },
        }
      );
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      maxRetries: 0,
      fetch: mockFetch,
    });

    await assert.rejects(
      async () => client.getJob('job_1'),
      (err: unknown) => {
        assert.ok(err instanceof VeyraApiError);
        assert.equal(err.status, 502);
        assert.equal(err.message, 'HTTP 502 Bad Gateway');
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  it('retries idempotent GET requests automatically and succeeds', async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('gateway timeout', {
          status: 504,
          statusText: 'Gateway Timeout',
        });
      }
      return new Response(JSON.stringify({ id: 'job_recovered', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      maxRetries: 2,
      fetch: mockFetch,
    });

    const job = await client.getJob('job_recovered');
    assert.equal(job.id, 'job_recovered');
    assert.equal(callCount, 2);
  });

  it('does NOT automatically retry non-idempotent POST without idempotency key', async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      return new Response('service unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      maxRetries: 3,
      fetch: mockFetch,
    });

    await assert.rejects(
      () => client.enqueue({ handler: 'send_email', payload: { ok: true } }),
      VeyraApiError
    );
    assert.equal(callCount, 1);
  });

  it('retries POST when idempotencyKey is supplied', async () => {
    let callCount = 0;
    const mockFetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('service unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      }
      return new Response(JSON.stringify({ id: 'job_idemp', status: 'queued' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      maxRetries: 2,
      fetch: mockFetch,
    });

    const job = await client.enqueue({
      handler: 'send_email',
      idempotencyKey: 'idemp_key_1',
      payload: { ok: true },
    });
    assert.equal(job.id, 'job_idemp');
    assert.equal(callCount, 2);
  });

  it('returns null on 204 No Content for claimJob', async () => {
    const mockFetch = (async () => {
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      fetch: mockFetch,
    });

    const claim = await client.claimJob('worker_1', { queues: ['default'] });
    assert.equal(claim, null);
  });

  it('parses claimed job on 200 OK for claimJob', async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          id: 'job_456',
          queue: 'default',
          handler: 'process_image',
          status: 'running',
          attempt: 1,
          maxAttempts: 3,
          priority: 5,
          payload: { url: 'https://example.com/img.png' },
          enqueuedAt: '2026-11-20T12:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'veyra_key',
      fetch: mockFetch,
    });

    const claim = await client.claimJob('worker_1', { queues: ['default'] });
    assert.ok(claim);
    assert.equal(claim.id, 'job_456');
    assert.equal(claim.handler, 'process_image');
  });
});
