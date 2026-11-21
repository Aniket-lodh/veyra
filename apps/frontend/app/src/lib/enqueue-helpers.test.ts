import type { QueueStatsResponse } from './api/stats';
import {
  BACKOFF_PRESETS,
  DEFAULT_CUSTOM_PAYLOAD_EXAMPLE,
  INITIAL_ENQUEUE_FORM,
  STARTER_PRESETS,
  buildEmailPayload,
  buildHttpPayload,
  buildNoopPayload,
  computeQueueReadiness,
  computeScheduledTime,
  ensureContentType,
  generateCurlSnippet,
  generateIdempotencyKey,
  generateULID,
  generateUUID,
  generateWorkerSnippet,
  hasContentType,
  headersToObject,
  isValidHttpUrl,
  splitEmailAddresses,
  validateAndParseEnqueueForm,
  type EnqueueFormState,
} from './enqueue-helpers.ts';
import type { Worker } from './types.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('enqueue-helpers', () => {
  describe('Header & Email Utilities', () => {
    it('detects Content-Type case-insensitively and handles spaces', () => {
      assert.equal(
        hasContentType([{ key: 'Authorization', value: 'Bearer x' }]),
        false,
      );
      assert.equal(
        hasContentType([{ key: 'content-type', value: 'application/json' }]),
        true,
      );
      assert.equal(
        hasContentType([{ key: '  Content-Type  ', value: 'text/plain' }]),
        true,
      );
    });

    it('ensures Content-Type row is added or fills empty row', () => {
      const emptyRow = [{ key: '', value: '' }];
      const filled = ensureContentType(emptyRow, 'application/json');
      assert.equal(filled.length, 1);
      assert.equal(filled[0]?.key, 'Content-Type');
      assert.equal(filled[0]?.value, 'application/json');

      const existing = [{ key: 'X-Custom', value: 'val' }];
      const added = ensureContentType(existing, 'text/plain');
      assert.equal(added.length, 2);
      assert.equal(added[1]?.key, 'Content-Type');
    });

    it('transforms header rows into a trimmed key-value object', () => {
      const rows = [
        { key: ' Authorization ', value: 'Bearer token123' },
        { key: '', value: 'ignored' },
        { key: 'X-Request-Id', value: 'req-987' },
      ];
      const obj = headersToObject(rows);
      assert.deepEqual(obj, {
        Authorization: 'Bearer token123',
        'X-Request-Id': 'req-987',
      });
    });

    it('splits email addresses separated by commas, semicolons, or newlines', () => {
      const input =
        'alice@example.com, bob@example.com; charlie@example.com\ndave@example.com';
      const list = splitEmailAddresses(input);
      assert.deepEqual(list, [
        'alice@example.com',
        'bob@example.com',
        'charlie@example.com',
        'dave@example.com',
      ]);
    });
  });

  describe('Payload Builders', () => {
    it('builds an http_request payload correctly with JSON body and headers', () => {
      const payload = buildHttpPayload({
        httpUrl: 'https://api.example.com/webhook',
        httpMethod: 'POST',
        httpHeaders: [{ key: 'Content-Type', value: 'application/json' }],
        httpBody: '{"event":"user.login"}',
        httpTimeoutSeconds: 45,
      });

      assert.equal(payload.url, 'https://api.example.com/webhook');
      assert.equal(payload.method, 'POST');
      assert.deepEqual(payload.headers, { 'Content-Type': 'application/json' });
      assert.deepEqual(payload.body, { event: 'user.login' });
      assert.equal(payload.timeoutSeconds, 45);
    });

    it('builds an http_request payload without headers or body if empty', () => {
      const payload = buildHttpPayload({
        httpUrl: 'https://api.example.com/health',
        httpMethod: 'GET',
        httpHeaders: [],
        httpBody: '',
        httpTimeoutSeconds: 0,
      });

      assert.equal(payload.url, 'https://api.example.com/health');
      assert.equal(payload.method, 'GET');
      assert.equal('headers' in payload, false);
      assert.equal('body' in payload, false);
      assert.equal('timeoutSeconds' in payload, false);
    });

    it('builds a send_email payload for single recipient and multi-recipient', () => {
      const single = buildEmailPayload({
        emailTo: 'user@example.com',
        emailFrom: 'bot@example.com',
        emailReplyTo: '',
        emailSubject: 'Welcome',
        emailText: 'Hello there',
        emailHtml: '<p>Hello there</p>',
      });

      assert.equal(single.to, 'user@example.com');
      assert.equal(single.from, 'bot@example.com');
      assert.equal('replyTo' in single, false);
      assert.equal(single.subject, 'Welcome');
      assert.equal(single.text, 'Hello there');
      assert.equal(single.html, '<p>Hello there</p>');

      const multi = buildEmailPayload({
        emailTo: 'user1@example.com, user2@example.com',
        emailFrom: '',
        emailReplyTo: 'support@example.com',
        emailSubject: 'Notice',
        emailText: 'Update',
        emailHtml: '',
      });
      assert.deepEqual(multi.to, ['user1@example.com', 'user2@example.com']);
      assert.equal(multi.replyTo, 'support@example.com');
      assert.equal('from' in multi, false);
    });

    it('builds a noop payload with message and optional simulated delay', () => {
      const noop1 = buildNoopPayload({
        noopMessage: 'Health check',
        noopSimulatedDelayMs: 0,
      });
      assert.equal(noop1.message, 'Health check');
      assert.equal('delayMs' in noop1, false);

      const noop2 = buildNoopPayload({
        noopMessage: '',
        noopSimulatedDelayMs: 150,
      });
      assert.equal(noop2.message, 'noop');
      assert.equal(noop2.delayMs, 150);
    });
  });

  describe('URL validation', () => {
    it('validates http and https protocols strictly', () => {
      assert.equal(isValidHttpUrl('https://example.com/api'), true);
      assert.equal(isValidHttpUrl('http://localhost:8080/hook'), true);
      assert.equal(isValidHttpUrl('ftp://example.com'), false);
      assert.equal(isValidHttpUrl('not-a-url'), false);
      assert.equal(isValidHttpUrl(''), false);
    });
  });

  describe('Form Validation & Parsing: validateAndParseEnqueueForm', () => {
    const baseForm: EnqueueFormState = {
      handlerType: 'http_request',
      customHandler: '',
      queue: 'default',
      priority: 5,
      maxAttempts: 3,
      backoffKind: 'exponential',
      backoffBaseSeconds: 30,
      backoffCapSeconds: 3600,
      backoffFixedSeconds: 30,
      backoffPreset: 'default',
      scheduledFor: '',
      idempotencyKey: 'idemp-12345',
      httpUrl: 'https://httpbin.org/post',
      httpMethod: 'POST',
      httpHeaders: [{ key: 'Content-Type', value: 'application/json' }],
      httpBody: '{"ping":true}',
      httpTimeoutSeconds: 30,
      emailTo: '',
      emailFrom: '',
      emailReplyTo: '',
      emailSubject: '',
      emailText: '',
      emailHtml: '',
      noopMessage: '',
      noopSimulatedDelayMs: 0,
      rawMode: false,
      rawPayload: '',
    };

    it('succeeds for valid HTTP request with all operational fields', () => {
      const res = validateAndParseEnqueueForm(baseForm);
      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.equal(res.value.handler, 'http_request');
      assert.equal(res.value.queue, 'default');
      assert.equal(res.value.priority, 5);
      assert.equal(res.value.maxAttempts, 3);
      assert.deepEqual(res.value.backoff, {
        kind: 'exponential',
        baseSeconds: 30,
        capSeconds: 3600,
      });
      assert.equal(res.value.idempotencyKey, 'idemp-12345');
    });

    it('validates priority bounds (0-9)', () => {
      const invalidLow = validateAndParseEnqueueForm({
        ...baseForm,
        priority: -1,
      });
      assert.equal(invalidLow.ok, false);
      assert.match(invalidLow.error, /Priority must be an integer between 0/);

      const invalidHigh = validateAndParseEnqueueForm({
        ...baseForm,
        priority: 10,
      });
      assert.equal(invalidHigh.ok, false);
      assert.match(invalidHigh.error, /Priority must be an integer between 0/);
    });

    it('validates maxAttempts (>= 1)', () => {
      const invalid = validateAndParseEnqueueForm({
        ...baseForm,
        maxAttempts: 0,
      });
      assert.equal(invalid.ok, false);
      assert.match(invalid.error, /Retry attempts must be an integer ≥ 1/);
    });

    it('validates exponential backoff base and cap seconds', () => {
      const invalidBase = validateAndParseEnqueueForm({
        ...baseForm,
        backoffKind: 'exponential',
        backoffBaseSeconds: 0,
      });
      assert.equal(invalidBase.ok, false);
      assert.match(
        invalidBase.error,
        /base seconds must be a positive integer/,
      );

      const invalidCap = validateAndParseEnqueueForm({
        ...baseForm,
        backoffKind: 'exponential',
        backoffBaseSeconds: 60,
        backoffCapSeconds: 30,
      });
      assert.equal(invalidCap.ok, false);
      assert.match(
        invalidCap.error,
        /cap seconds must be greater than or equal to base seconds/,
      );
    });

    it('validates fixed backoff seconds', () => {
      const validFixed = validateAndParseEnqueueForm({
        ...baseForm,
        backoffKind: 'fixed',
        backoffFixedSeconds: 15,
      });
      assert.equal(validFixed.ok, true);
      if (!validFixed.ok) return;
      assert.deepEqual(validFixed.value.backoff, {
        kind: 'fixed',
        seconds: 15,
      });

      const invalidFixed = validateAndParseEnqueueForm({
        ...baseForm,
        backoffKind: 'fixed',
        backoffFixedSeconds: 0,
      });
      assert.equal(invalidFixed.ok, false);
    });

    it('validates custom handler and raw JSON mode', () => {
      const customForm: EnqueueFormState = {
        ...baseForm,
        handlerType: 'custom',
        customHandler: 'order_indexer',
        rawMode: true,
        rawPayload: '{"orderId":"ord_998"}',
      };
      const res = validateAndParseEnqueueForm(customForm);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.value.handler, 'order_indexer');
      assert.deepEqual(res.value.payload, { orderId: 'ord_998' });

      const invalidJson = validateAndParseEnqueueForm({
        ...customForm,
        rawPayload: '{invalid-json}',
      });
      assert.equal(invalidJson.ok, false);
      assert.match(invalidJson.error, /Invalid JSON payload/);
    });

    it('validates ISO scheduled time when specified', () => {
      const formWithSchedule = {
        ...baseForm,
        scheduledFor: '2026-12-01T12:00',
      };
      const res = validateAndParseEnqueueForm(formWithSchedule);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(typeof res.value.scheduledFor, 'string');
      assert.match(res.value.scheduledFor as string, /2026-12-01T/);
    });

    it('omits scheduledFor for immediate jobs when scheduledFor is empty', () => {
      const formImmediate = {
        ...baseForm,
        scheduledFor: '',
      };
      const res = validateAndParseEnqueueForm(formImmediate);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.value.scheduledFor, undefined);
    });
  });

  describe('Idempotency Key Generators', () => {
    it('generates a valid UUIDv4', () => {
      const uuid = generateUUID();
      assert.match(
        uuid,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a valid 26-char ULID', () => {
      const ulid = generateULID();
      assert.equal(ulid.length, 26);
      assert.match(ulid, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    });

    it('applies prefixes to idempotency keys correctly', () => {
      const key = generateIdempotencyKey('ulid', 'job-checkout');
      assert.match(
        key,
        /^job-checkout-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/,
      );
    });
  });

  describe('Schedule Time Offsets', () => {
    it('computes local datetime string offset correctly', () => {
      const base = new Date('2026-05-10T10:00:00Z');
      const offset5m = computeScheduledTime(5, base);
      assert.equal(typeof offset5m, 'string');
      assert.match(offset5m, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

      const offsetZero = computeScheduledTime(0, base);
      assert.equal(offsetZero, '');
    });
  });

  describe('computeQueueReadiness', () => {
    const stats: QueueStatsResponse = {
      totals: {
        queued: 5,
        scheduled: 0,
        running: 2,
        succeeded: 100,
        failed: 3,
        deadLettered: 0,
        cancelled: 1,
      },
      queues: [
        {
          name: 'default',
          depth: 5,
          inFlight: 2,
          succeeded24h: 100,
          failed24h: 3,
          deadLettered24h: 0,
        },
      ],
    };

    const mockWorkers: Worker[] = [
      {
        id: 'wrk_1',
        hostname: 'worker-node-1',
        pid: 101,
        version: '1.0.0',
        state: 'active',
        startedAt: '2026-01-01T00:00:00Z',
        lastHeartbeatAt: '2026-01-01T00:00:00Z',
        heartbeatIntervalSeconds: 10,
        queues: ['default'],
        handlers: ['http_request', 'noop'],
        maxConcurrency: 10,
        inFlight: 2,
        totalProcessed: 50,
        leases: [],
      },
    ];

    it('detects healthy readiness when workers exist for queue and handler', () => {
      const readiness = computeQueueReadiness(
        'default',
        'http_request',
        stats,
        mockWorkers,
      );
      assert.equal(readiness.status, 'healthy');
      assert.equal(readiness.totalFleetWorkers, 1);
      assert.equal(readiness.queueWorkers, 1);
      assert.equal(readiness.handlerWorkers, 1);
      assert.equal(readiness.queueDepth, 5);
      assert.equal(readiness.warning, undefined);
    });

    it('detects unserviced queue warning when 0 workers support the handler or queue', () => {
      const unservicedHandler = computeQueueReadiness(
        'default',
        'send_email',
        stats,
        mockWorkers,
      );
      assert.equal(unservicedHandler.status, 'unserviced');
      assert.equal(unservicedHandler.handlerWorkers, 0);
      assert.match(
        unservicedHandler.warning as string,
        /No active workers are subscribed/,
      );

      const unservicedQueue = computeQueueReadiness(
        'isolated-queue',
        'http_request',
        stats,
        mockWorkers,
      );
      assert.equal(unservicedQueue.status, 'unserviced');
      assert.equal(unservicedQueue.queueWorkers, 0);
    });

    it('detects no-workers condition when entire fleet is empty or disconnected', () => {
      const noWorkers = computeQueueReadiness(
        'default',
        'http_request',
        stats,
        [],
      );
      assert.equal(noWorkers.status, 'no-workers');
      assert.match(
        noWorkers.warning as string,
        /Zero active workers in the entire fleet/,
      );
    });

    it('detects loading condition when fleet stats or workers are loading', () => {
      const loading = computeQueueReadiness(
        'default',
        'http_request',
        undefined,
        undefined,
        true,
      );
      assert.equal(loading.status, 'loading');
      assert.equal(loading.warning, undefined);
    });
  });

  describe('generateCurlSnippet', () => {
    it('generates an accurate, reproducible curl command', () => {
      const curl = generateCurlSnippet(
        {
          handler: 'http_request',
          queue: 'default',
          priority: 7,
          maxAttempts: 5,
          idempotencyKey: 'test-key-99',
          callbackUrl: 'https://api.my-service.com/webhook',
          payload: { url: 'https://example.com' },
        },
        'http://localhost:8008',
      );

      assert.match(curl, /curl -X POST "http:\/\/localhost:8008\/jobs"/);
      assert.match(curl, /-H "Content-Type: application\/json"/);
      assert.match(curl, /-H "Idempotency-Key: test-key-99"/);
      assert.match(curl, /"handler": "http_request"/);
      assert.match(curl, /"priority": 7/);
      assert.match(
        curl,
        /"callbackUrl": "https:\/\/api\.my-service\.com\/webhook"/,
      );
    });
  });

  describe('Callback URL Validation', () => {
    const testForm: EnqueueFormState = {
      ...INITIAL_ENQUEUE_FORM,
      httpUrl: 'https://example.com/api',
    };

    it('accepts valid HTTP and HTTPS callback URLs', () => {
      const valid1 = validateAndParseEnqueueForm({
        ...testForm,
        callbackUrl: 'https://webhook.site/abc',
      });
      assert.equal(valid1.ok, true);
      if (!valid1.ok) return;
      assert.equal(valid1.value.callbackUrl, 'https://webhook.site/abc');

      const valid2 = validateAndParseEnqueueForm({
        ...testForm,
        callbackUrl: 'http://localhost:3000/callback',
      });
      assert.equal(valid2.ok, true);
      if (!valid2.ok) return;
      assert.equal(valid2.value.callbackUrl, 'http://localhost:3000/callback');
    });

    it('rejects invalid or non-http callback URLs', () => {
      const invalidScheme = validateAndParseEnqueueForm({
        ...testForm,
        callbackUrl: 'ftp://example.com/webhook',
      });
      assert.equal(invalidScheme.ok, false);
      if (invalidScheme.ok) return;
      assert.match(
        invalidScheme.error,
        /Callback URL must be a valid HTTP or HTTPS URL/,
      );

      const invalidDomain = validateAndParseEnqueueForm({
        ...testForm,
        callbackUrl: 'not-a-valid-url',
      });
      assert.equal(invalidDomain.ok, false);
      if (invalidDomain.ok) return;
      assert.match(
        invalidDomain.error,
        /Callback URL must be a valid HTTP or HTTPS URL/,
      );
    });
  });

  describe('generateWorkerSnippet & Custom Helpers', () => {
    it('generates a copy-pasteable TypeScript worker snippet tailored to handler and queue', () => {
      const snippet = generateWorkerSnippet(
        'sync_inventory',
        'warehouse',
        'http://localhost:8008',
      );

      assert.match(
        snippet,
        /import \{ VeyraClient, NonRetryableError \} from '@aniket-lodh\/veyra-sdk'/,
      );
      assert.match(
        snippet,
        /baseUrl: process\.env\.VEYRA_API_URL \|\| 'http:\/\/localhost:8008'/,
      );
      assert.match(snippet, /queues: \['warehouse'\]/);
      assert.match(
        snippet,
        /worker\.registerHandler\('sync_inventory', async \(job, ctx\) =>/,
      );
      assert.match(snippet, /if \(ctx\.signal\.aborted\)/);
      assert.match(snippet, /await worker\.start\(\)/);
    });

    it('falls back to default handler and queue names when empty', () => {
      const snippet = generateWorkerSnippet('', '', 'http://api.internal');
      assert.match(snippet, /queues: \['default'\]/);
      assert.match(snippet, /worker\.registerHandler\('my_custom_task',/);
    });

    it('contains a valid JSON custom payload example', () => {
      const parsed = JSON.parse(DEFAULT_CUSTOM_PAYLOAD_EXAMPLE);
      assert.equal(parsed.action, 'process_event');
      assert.equal(parsed.entityId, 'ent_98124');
    });
  });

  describe('Presets sanity', () => {
    it('has valid starter presets and backoff presets', () => {
      assert.equal(STARTER_PRESETS.length >= 5, true);
      assert.equal(BACKOFF_PRESETS.length >= 5, true);
    });
  });
});
