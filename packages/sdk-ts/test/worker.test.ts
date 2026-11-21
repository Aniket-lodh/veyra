import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import util from 'node:util';
import {
  LeaseLostError,
  NonRetryableError,
  VeyraClient,
  VeyraError,
  VeyraNotFoundError,
  VeyraWorker,
} from '../dist/index.js';

describe('VeyraWorker', () => {
  it('throws on missing queues', () => {
    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test' });
    assert.throws(() => new VeyraWorker(client, { queues: [] }), VeyraError);
  });

  it('defaults getEffectiveHandlers() to registered handler names when options.handlers is omitted', () => {
    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test' });
    const worker = new VeyraWorker(client, { queues: ['default'] });

    assert.deepEqual(worker.getEffectiveHandlers(), []);

    worker.registerHandler('resize_image', () => {});
    worker.registerHandler('send_push', () => {});

    assert.deepEqual(worker.getEffectiveHandlers(), ['resize_image', 'send_push']);
  });

  it('uses options.handlers when explicitly provided', () => {
    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test' });
    const worker = new VeyraWorker(client, {
      queues: ['default'],
      handlers: ['custom_queue_handler'],
    });

    worker.registerHandler('resize_image', () => {});

    assert.deepEqual(worker.getEffectiveHandlers(), ['custom_queue_handler']);
  });

  it('registers worker on start and executes claimed jobs', async () => {
    const apiCalls: Array<{ path: string; method: string; body?: unknown }> = [];

    let claimCount = 0;
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('http://localhost:8080', '');
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      apiCalls.push({ path, method, body });

      if (path === '/workers/register') {
        return new Response(
          JSON.stringify({
            id: 'worker_node_1',
            hostname: 'node-host',
            pid: 1234,
            version: '0.1.0',
            state: 'active',
            queues: ['default'],
            handlers: ['report_generator'],
            maxConcurrency: 2,
            inFlight: 0,
            totalProcessed: 0,
            leases: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.endsWith('/claim')) {
        claimCount++;
        if (claimCount === 1) {
          return new Response(
            JSON.stringify({
              id: 'job_claim_1',
              queue: 'default',
              handler: 'report_generator',
              status: 'running',
              attempt: 1,
              maxAttempts: 3,
              priority: 5,
              payload: { reportId: 'rep_99' },
              enqueuedAt: '2026-11-20T12:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // 204 No Content for subsequent claims
        return new Response(null, { status: 204 });
      }

      if (path.includes('/complete')) {
        return new Response(
          JSON.stringify({ completed: true, jobId: 'job_claim_1', workerId: 'worker_node_1', status: 'succeeded' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.endsWith('/drain')) {
        return new Response(JSON.stringify({ state: 'draining' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (path.endsWith('/deregister')) {
        return new Response(JSON.stringify({ deregistered: true, workerId: 'worker_node_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test_key',
      fetch: mockFetch,
    });

    let jobExecuted = false;
    const worker = new VeyraWorker(client, {
      queues: ['default'],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 500,
    });

    worker.registerHandler('report_generator', async (job, ctx) => {
      assert.equal(job.id, 'job_claim_1');
      assert.equal(ctx.jobId, 'job_claim_1');
      assert.equal(ctx.queue, 'default');
      assert.equal(ctx.handler, 'report_generator');
      assert.equal(ctx.attempt, 1);
      jobExecuted = true;
      return { generated: true, url: 'https://cdn.example.com/rep_99.pdf' };
    });

    await worker.start();

    // Allow claim and execution loop to run
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(jobExecuted, true);

    // Stop worker cleanly
    await worker.stop({ timeoutMs: 1000 });

    const registered = apiCalls.find((c) => c.path === '/workers/register');
    assert.ok(registered);
    assert.deepEqual(registered.body.handlers, ['report_generator']);

    const completed = apiCalls.find((c) => c.path.includes('/complete'));
    assert.ok(completed);
    assert.deepEqual(completed.body, { result: { generated: true, url: 'https://cdn.example.com/rep_99.pdf' } });

    const drained = apiCalls.find((c) => c.path.endsWith('/drain'));
    assert.ok(drained);

    const deregistered = apiCalls.find((c) => c.path.endsWith('/deregister'));
    assert.ok(deregistered);
  });

  it('stops renewing lease immediately on 409 Conflict and aborts ctx.signal', async () => {
    let leaseRenewalAttempts = 0;
    let signalAborted = false;
    let claimCount = 0;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('http://localhost:8080', '');

      if (path === '/workers/register') {
        return new Response(JSON.stringify({ id: 'worker_lease_test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.endsWith('/claim')) {
        claimCount++;
        if (claimCount === 1) {
          return new Response(
            JSON.stringify({
              id: 'job_lease_1',
              queue: 'default',
              handler: 'long_task',
              status: 'running',
              attempt: 1,
              maxAttempts: 3,
              priority: 5,
              payload: {},
              enqueuedAt: '2026-11-20T12:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(null, { status: 204 });
      }

      if (path.includes('/jobs/job_lease_1/heartbeat')) {
        leaseRenewalAttempts++;
        // Return 409 Conflict on lease heartbeat
        return new Response(JSON.stringify({ error: 'lease lost or expired' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.includes('/fail') || path.includes('/complete') || path.includes('/drain') || path.includes('/deregister')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test_key',
      fetch: mockFetch,
    });

    const worker = new VeyraWorker(client, {
      queues: ['default'],
      pollIntervalMs: 50,
      leaseHeartbeatIntervalMs: 20, // Rapid heartbeat for test
    });

    worker.registerHandler('long_task', async (_job, ctx) => {
      // Wait for signal abort triggered by 409
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          signalAborted = true;
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => {
          signalAborted = true;
          resolve();
        });
      });
      throw new Error('Task aborted due to lease lost');
    });

    await worker.start();

    // Allow time for claim + lease heartbeat attempt
    await new Promise((r) => setTimeout(r, 90));

    assert.equal(signalAborted, true);
    assert.equal(leaseRenewalAttempts, 1);

    await worker.stop({ timeoutMs: 500 });
  });

  it('reports permanent failure when NonRetryableError is thrown', async () => {
    let failureBody: { errorClass?: string; message?: string; permanent?: boolean } | undefined;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('http://localhost:8080', '');

      if (path === '/workers/register') {
        return new Response(JSON.stringify({ id: 'worker_fail_test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.endsWith('/claim')) {
        return new Response(
          JSON.stringify({
            id: 'job_fail_1',
            queue: 'default',
            handler: 'invalid_data_handler',
            status: 'running',
            attempt: 1,
            maxAttempts: 3,
            priority: 5,
            payload: {},
            enqueuedAt: '2026-11-20T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (path.includes('/fail')) {
        failureBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ failed: true, permanent: true, terminal: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test_key',
      fetch: mockFetch,
    });

    const worker = new VeyraWorker(client, {
      queues: ['default'],
      pollIntervalMs: 50,
    });

    worker.registerHandler('invalid_data_handler', async () => {
      throw new NonRetryableError('Invalid schema payload - do not retry');
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 60));
    await worker.stop({ timeoutMs: 500 });

    assert.ok(failureBody);
    assert.equal(failureBody.permanent, true);
    assert.equal(failureBody.errorClass, 'NonRetryableError');
    assert.equal(failureBody.message, 'Invalid schema payload - do not retry');
  });

  it('re-registers transparently when worker heartbeat encounters 404', async () => {
    let registerCount = 0;
    let heartbeatCount = 0;

    const mockFetch = (async (url: string | URL | Request) => {
      const path = String(url).replace('http://localhost:8080', '');

      if (path === '/workers/register') {
        registerCount++;
        return new Response(JSON.stringify({ id: 'worker_recover_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.endsWith('/heartbeat')) {
        heartbeatCount++;
        if (heartbeatCount === 1) {
          // Worker was evicted on server
          return new Response(JSON.stringify({ error: 'worker not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 'worker_recover_1', state: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new VeyraClient({
      baseUrl: 'http://localhost:8080',
      apiKey: 'test_key',
      fetch: mockFetch,
    });

    const worker = new VeyraWorker(client, {
      queues: ['default'],
      handlers: ['test_handler'],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 25, // Quick heartbeat
    });

    worker.registerHandler('test_handler', () => {});

    await worker.start();
    assert.equal(registerCount, 1);

    // Wait for heartbeat timer to fire and 404 to trigger re-register
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(registerCount >= 2, `Expected registerCount >= 2, got ${registerCount}`);

    await worker.stop({ timeoutMs: 500 });
  });

  it('throws when attempting to register a duplicate handler', () => {
    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test' });
    const worker = new VeyraWorker(client, { queues: ['default'] });
    worker.registerHandler('my_handler', () => {});
    assert.throws(
      () => worker.registerHandler('my_handler', () => {}),
      (err: any) => err instanceof VeyraError && err.code === 'DUPLICATE_HANDLER'
    );
  });

  it('throws when starting an already active worker', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ id: 'worker_double_start' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test', fetch: mockFetch });
    const worker = new VeyraWorker(client, { queues: ['default'] });
    worker.registerHandler('test', () => {});

    await worker.start();
    await assert.rejects(
      async () => worker.start(),
      (err: any) => err instanceof VeyraError && err.code === 'ALREADY_RUNNING'
    );
    await worker.stop({ timeoutMs: 500 });
  });

  it('redacts sensitive internal state in toJSON and util.inspect', () => {
    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'secret_worker_key' });
    const worker = new VeyraWorker(client, { queues: ['q1', 'q2'], concurrency: 5 });

    const json = JSON.stringify(worker);
    assert.equal(json.includes('secret_worker_key'), false);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.queues, ['q1', 'q2']);
    assert.equal(parsed.concurrency, 5);

    const inspected = util.inspect(worker);
    assert.equal(inspected.includes('secret_worker_key'), false);
  });

  it('safely handles non-Error throws in handler (strings, objects)', async () => {
    let failPayload: { errorClass?: string; message?: string } | undefined;
    let claimCount = 0;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace('http://localhost:8080', '');
      if (path === '/workers/register') {
        return new Response(JSON.stringify({ id: 'worker_throw_test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path.endsWith('/claim')) {
        claimCount++;
        if (claimCount === 1) {
          return new Response(
            JSON.stringify({
              id: 'job_throw_1',
              queue: 'default',
              handler: 'string_thrower',
              status: 'running',
              attempt: 1,
              maxAttempts: 3,
              priority: 5,
              payload: {},
              enqueuedAt: '2026-11-20T12:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(null, { status: 204 });
      }
      if (path.includes('/fail')) {
        failPayload = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new VeyraClient({ baseUrl: 'http://localhost:8080', apiKey: 'test', fetch: mockFetch });
    const worker = new VeyraWorker(client, { queues: ['default'], pollIntervalMs: 50 });
    worker.registerHandler('string_thrower', () => {
      throw 'unexpected raw string error';
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 60));
    await worker.stop({ timeoutMs: 500 });

    assert.ok(failPayload);
    assert.equal(failPayload.message, 'unexpected raw string error');
  });
});
