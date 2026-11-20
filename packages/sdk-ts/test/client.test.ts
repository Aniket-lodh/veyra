import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LeaseLostError,
  VeyraApiError,
  VeyraAuthError,
  VeyraClient,
  VeyraConflictError,
  VeyraError,
  VeyraNotFoundError,
} from '../dist/index.js';

describe('VeyraClient', () => {
  it('throws on missing baseUrl or apiKey', () => {
    assert.throws(() => new VeyraClient({ baseUrl: '', apiKey: 'veyra_test' }), VeyraError);
    assert.throws(() => new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: '' }), VeyraError);
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

    assert.equal(job.id, 'job_123');
    assert.equal(job.isReplay, true);
  });

  it('translates 401 and 403 to VeyraAuthError', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ error: 'invalid api key' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
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
        return true;
      }
    );
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
