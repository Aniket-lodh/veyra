import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defineHandler,
  staticSchema,
  VeyraClient,
  VeyraError,
  VeyraValidationError,
  VeyraWorker,
  type JobClaim,
  type JobContext,
  type StandardSchemaV1,
} from '../dist/index.js';

function syncSchema<T>(
  check: (value: unknown) => value is T,
  message = 'invalid value'
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value) {
        return check(value)
          ? { value }
          : { issues: [{ message, path: ['field'] }] };
      },
    },
  };
}

function asyncSchema<T>(
  check: (value: unknown) => value is T
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      async validate(value) {
        return check(value)
          ? { value }
          : { issues: [{ message: 'async invalid' }] };
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): VeyraClient {
  return new VeyraClient({
    baseUrl: 'http://localhost:8080',
    apiKey: 'test_key',
    fetch: fetchImpl,
  });
}

function claimedJob<TPayload>(payload: TPayload): JobClaim<TPayload> {
  return {
    id: 'job_1',
    queue: 'default',
    handler: 'test_handler',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    priority: 5,
    payload,
    leaseExpiresAt: null,
    startedAt: null,
    enqueuedAt: '2026-01-01T00:00:00Z',
  };
}

const context: JobContext = {
  jobId: 'job_1',
  attempt: 1,
  queue: 'default',
  handler: 'test_handler',
  signal: new AbortController().signal,
  extendLease: async () => ({
    renewed: true,
    jobId: 'job_1',
    workerId: 'worker_1',
    leaseExpiresAt: '2026-01-01T00:00:30Z',
  }),
};

describe('defineHandler', () => {
  it('trims the name and keeps queue and schemas', () => {
    const payload = staticSchema<{ to: string }>();
    const result = staticSchema<{ messageId: string }>();
    const definition = defineHandler({
      name: ' send_email ',
      queue: 'emails',
      payload,
      result,
    });

    assert.equal(definition.name, 'send_email');
    assert.equal(definition.queue, 'emails');
    assert.equal(definition.payload, payload);
    assert.equal(definition.result, result);
  });

  it('rejects an empty name', () => {
    assert.throws(() => defineHandler({ name: '  ' }), VeyraError);
  });

  it('staticSchema is compile-time only', () => {
    assert.equal(staticSchema<{ id: string }>(), undefined);
  });
});

describe('VeyraClient typed enqueue', () => {
  it('validates a sync payload and uses the definition queue', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const definition = defineHandler({
      name: 'send_email',
      queue: 'emails',
      payload: syncSchema<{ to: string }>(
        (value): value is { to: string } =>
          typeof value === 'object' && value !== null && typeof (value as { to?: unknown }).to === 'string'
      ),
    });

    const client = makeClient((async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse({ id: 'job_1', handler: 'send_email', queue: 'emails' });
    }) as typeof fetch);

    const job = await client.enqueue(definition, { to: 'a@b.c' }, { priority: 4 });

    assert.equal(job.id, 'job_1');
    assert.equal(captured?.url, 'http://localhost:8080/jobs');
    const body = JSON.parse(captured?.init.body as string);
    assert.equal(body.handler, 'send_email');
    assert.equal(body.queue, 'emails');
    assert.deepEqual(body.payload, { to: 'a@b.c' });
    assert.equal(body.priority, 4);
  });

  it('validates and enqueues using object form with handler definition', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const definition = defineHandler({
      name: 'send_email',
      queue: 'emails',
      payload: syncSchema<{ to: string }>(
        (value): value is { to: string } =>
          typeof value === 'object' && value !== null && typeof (value as { to?: unknown }).to === 'string',
        'to must be a string'
      ),
    });

    const client = makeClient((async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse({ id: 'job_obj_1', handler: 'send_email', queue: 'emails' });
    }) as typeof fetch);

    const job = await client.enqueue({
      handler: definition,
      payload: { to: 'user@example.com' },
      priority: 8,
    });

    assert.equal(job.id, 'job_obj_1');
    assert.equal(captured?.url, 'http://localhost:8080/jobs');
    const body = JSON.parse(captured?.init.body as string);
    assert.equal(body.handler, 'send_email');
    assert.equal(body.queue, 'emails');
    assert.deepEqual(body.payload, { to: 'user@example.com' });
    assert.equal(body.priority, 8);

    await assert.rejects(
      () =>
        client.enqueue({
          handler: definition,
          payload: { to: 123 } as unknown as { to: string },
        }),
      VeyraValidationError
    );
  });

  it('supports async Standard Schema validation', async () => {
    const definition = defineHandler({
      name: 'async_handler',
      payload: asyncSchema<{ id: number }>(
        (value): value is { id: number } =>
          typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
      ),
    });
    const client = makeClient((async () =>
      jsonResponse({ id: 'job_2' })) as typeof fetch);

    const job = await client.enqueue(definition, { id: 7 });
    assert.equal(job.id, 'job_2');
  });

  it('throws VeyraValidationError with issues before sending', async () => {
    let called = false;
    const definition = defineHandler({
      name: 'send_email',
      payload: syncSchema<{ to: string }>(
        (value): value is { to: string } =>
          typeof value === 'object' && value !== null && typeof (value as { to?: unknown }).to === 'string',
        'to must be a string'
      ),
    });
    const client = makeClient((async () => {
      called = true;
      return jsonResponse({});
    }) as typeof fetch);

    await assert.rejects(
      () => client.enqueue(definition, { to: 1 } as unknown as { to: string }),
      (err: unknown) => {
        assert.ok(err instanceof VeyraValidationError);
        assert.equal(err.permanent, true);
        assert.equal(err.issues.length, 1);
        assert.match(err.message, /field: to must be a string/);
        return true;
      }
    );
    assert.equal(called, false);
  });

  it('skips runtime validation for static schemas', async () => {
    let payloadSent: unknown;
    const definition = defineHandler({
      name: 'static_handler',
      payload: staticSchema<{ id: string }>(),
    });
    const client = makeClient((async (_url: string | URL | Request, init?: RequestInit) => {
      payloadSent = JSON.parse(init?.body as string).payload;
      return jsonResponse({ id: 'job_3' });
    }) as typeof fetch);

    await client.enqueue(definition, { id: 42 } as unknown as { id: string });
    assert.deepEqual(payloadSent, { id: 42 });
  });

  it('validates a fetched result with the definition schema', async () => {
    const definition = defineHandler({
      name: 'report',
      result: syncSchema<{ ok: boolean }>(
        (value): value is { ok: boolean } =>
          typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean',
        'ok must be boolean'
      ),
    });

    const validClient = makeClient((async () =>
      jsonResponse({ id: 'job_4', result: { ok: true } })) as typeof fetch);
    const valid = await validClient.getJob('job_4', definition);
    assert.deepEqual(valid.result, { ok: true });

    const invalidClient = makeClient((async () =>
      jsonResponse({ id: 'job_4', result: { ok: 'yes' } })) as typeof fetch);
    await assert.rejects(
      () => invalidClient.getJob('job_4', definition),
      VeyraValidationError
    );
  });

  it('fetches a job for a named built-in handler string', async () => {
    const client = makeClient((async () =>
      jsonResponse({
        id: 'job_http',
        handler: 'http_request',
        result: {
          statusCode: 200,
          durationMs: 12,
          contentType: 'application/json',
          responseExcerpt: '{"status":"ok"}',
        },
      })) as typeof fetch);

    const job = await client.getJob('job_http', 'http_request');
    assert.equal(job.id, 'job_http');
    assert.equal(job.result?.statusCode, 200);
    assert.equal(job.result?.responseExcerpt, '{"status":"ok"}');
  });
});

describe('VeyraWorker typed register', () => {
  it('validates the payload before invoking the callback', async () => {
    const client = makeClient((async () => jsonResponse({})) as typeof fetch);
    const worker = new VeyraWorker(client, { queues: ['default'] });
    let invoked = false;

    worker.register(
      defineHandler({
        name: 'strict_payload',
        payload: syncSchema<{ id: number }>(
          (value): value is { id: number } =>
            typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ),
      }),
      async (job) => {
        invoked = true;
        return job.payload.id;
      }
    );

    const handler = worker.handlers.get('strict_payload');
    assert.ok(handler);

    await assert.rejects(
      () => Promise.resolve(handler(claimedJob({ id: 'nope' }), context)),
      VeyraValidationError
    );
    assert.equal(invoked, false);
  });

  it('validates the returned result and passes valid values through', async () => {
    const client = makeClient((async () => jsonResponse({})) as typeof fetch);
    const worker = new VeyraWorker(client, { queues: ['default'] });

    worker.register(
      defineHandler({
        name: 'strict_result',
        result: syncSchema<{ messageId: string }>(
          (value): value is { messageId: string } =>
            typeof value === 'object' && value !== null && typeof (value as { messageId?: unknown }).messageId === 'string',
          'messageId must be a string'
        ),
      }),
      async () => ({ messageId: 'msg_1' })
    );

    const handler = worker.handlers.get('strict_result');
    assert.ok(handler);

    const result = await Promise.resolve(handler(claimedJob({}), context));
    assert.deepEqual(result, { messageId: 'msg_1' });

    worker.register(
      defineHandler({
        name: 'bad_result',
        result: syncSchema<{ messageId: string }>(
          (value): value is { messageId: string } =>
            typeof value === 'object' && value !== null && typeof (value as { messageId?: unknown }).messageId === 'string',
          'messageId must be a string'
        ),
      }),
      async () => ({ messageId: 42 }) as unknown as { messageId: string }
    );

    const badHandler = worker.handlers.get('bad_result');
    assert.ok(badHandler);
    await assert.rejects(
      () => Promise.resolve(badHandler(claimedJob({}), context)),
      VeyraValidationError
    );
  });

  it('passes the validated payload to the callback', async () => {
    const client = makeClient((async () => jsonResponse({})) as typeof fetch);
    const worker = new VeyraWorker(client, { queues: ['default'] });
    let received: unknown;

    worker.register(
      defineHandler({
        name: 'payload_passthrough',
        payload: syncSchema<{ id: number }>(
          (value): value is { id: number } =>
            typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ),
      }),
      async (job) => {
        received = job.payload;
        return true;
      }
    );

    const handler = worker.handlers.get('payload_passthrough');
    assert.ok(handler);
    await Promise.resolve(handler(claimedJob({ id: 3 }), context));
    assert.deepEqual(received, { id: 3 });
  });

  it('keeps string-based registerHandler working', async () => {
    const client = makeClient((async () => jsonResponse({})) as typeof fetch);
    const worker = new VeyraWorker(client, { queues: ['default'] });

    worker.registerHandler<{ value: number }, { doubled: number }>(
      'legacy',
      async (job) => ({ doubled: job.payload.value * 2 })
    );

    const handler = worker.handlers.get('legacy');
    assert.ok(handler);
    const result = await Promise.resolve(handler(claimedJob({ value: 4 }), context));
    assert.deepEqual(result, { doubled: 8 });
  });
});
