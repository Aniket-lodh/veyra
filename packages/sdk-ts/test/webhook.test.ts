import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  defineHandler,
  parseWebhook,
  verifyWebhookSignature,
  VeyraError,
  VeyraValidationError,
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
          : { issues: [{ message, path: ['messageId'] }] };
      },
    },
  };
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const eventBody = JSON.stringify({
  event: 'job.completed',
  jobId: '01JOB',
  queue: 'default',
  handler: 'send_email',
  status: 'succeeded',
  attempt: 1,
  maxAttempts: 3,
  payload: { to: 'a@b.c' },
  result: { messageId: 'msg_1' },
  error: null,
  enqueuedAt: '2026-01-01T00:00:00Z',
  startedAt: '2026-01-01T00:00:01Z',
  completedAt: '2026-01-01T00:00:02Z',
  cancelledAt: null,
  deadLetteredAt: null,
  callbackAttempts: 1,
});

const secret = 'whsec_test';

describe('verifyWebhookSignature', () => {
  it('accepts a valid sha256 HMAC signature', async () => {
    assert.equal(
      await verifyWebhookSignature(eventBody, sign(eventBody, secret), secret),
      true
    );
  });

  it('rejects wrong secrets, missing headers, and malformed values', async () => {
    assert.equal(
      await verifyWebhookSignature(eventBody, sign(eventBody, 'other'), secret),
      false
    );
    assert.equal(await verifyWebhookSignature(eventBody, undefined, secret), false);
    assert.equal(await verifyWebhookSignature(eventBody, 'md5=abc', secret), false);
    assert.equal(await verifyWebhookSignature(eventBody, 'sha256=zz', secret), false);
  });

  it('verifies raw bytes identically to the string body', async () => {
    const bytes = new TextEncoder().encode(eventBody);
    assert.equal(await verifyWebhookSignature(bytes, sign(eventBody, secret), secret), true);
  });
});

describe('parseWebhook', () => {
  it('verifies the signature and returns the typed event', async () => {
    const event = await parseWebhook(eventBody, {
      secret,
      signature: sign(eventBody, secret),
    });

    assert.equal(event.jobId, '01JOB');
    assert.equal(event.status, 'succeeded');
    assert.deepEqual(event.result, { messageId: 'msg_1' });
  });

  it('rejects an invalid signature', async () => {
    await assert.rejects(
      () =>
        parseWebhook(eventBody, {
          secret,
          signature: sign(eventBody, 'wrong'),
        }),
      VeyraError
    );
  });

  it('rejects a missing signature when a secret is configured', async () => {
    await assert.rejects(() => parseWebhook(eventBody, { secret }), VeyraError);
  });

  it('parses without verification when no secret is supplied', async () => {
    const event = await parseWebhook(eventBody);
    assert.equal(event.handler, 'send_email');
  });

  it('validates the result with a definition schema', async () => {
    const definition = defineHandler({
      name: 'send_email',
      result: syncSchema<{ messageId: string }>(
        (value): value is { messageId: string } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { messageId?: unknown }).messageId === 'string',
        'messageId must be a string'
      ),
    });

    const event = await parseWebhook(eventBody, definition, {
      secret,
      signature: sign(eventBody, secret),
    });
    assert.deepEqual(event.result, { messageId: 'msg_1' });

    const invalidBody = eventBody.replace('"msg_1"', '42');
    await assert.rejects(
      () =>
        parseWebhook(invalidBody, definition, {
          secret,
          signature: sign(invalidBody, secret),
        }),
      VeyraValidationError
    );
  });

  it('rejects malformed JSON', async () => {
    await assert.rejects(() => parseWebhook('{not json'), VeyraError);
  });
});
