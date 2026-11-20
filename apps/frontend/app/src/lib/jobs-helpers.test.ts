import type { QueueStatsResponse } from './api/stats';
import {
  CANCELLABLE_STATUS_SET,
  computeJobsMetrics,
  extractQueueOptions,
  formatAttemptRatio,
  formatPayloadSummary,
  getPriorityMeta,
  inferTabFromStatuses,
  isJobCancellable,
  isJobRetryable,
  mapTabToStatuses,
  RETRYABLE_STATUS_SET,
  validateJsonString,
} from './jobs-helpers.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('jobs-helpers', () => {
  describe('isJobCancellable & CANCELLABLE_STATUS_SET', () => {
    it('allows cancelling queued, scheduled, running, and failed jobs', () => {
      assert.equal(CANCELLABLE_STATUS_SET.size, 4);
      assert.equal(CANCELLABLE_STATUS_SET.has('queued'), true);
      assert.equal(isJobCancellable('queued'), true);
      assert.equal(isJobCancellable('scheduled'), true);
      assert.equal(isJobCancellable('running'), true);
      assert.equal(isJobCancellable('failed'), true);
    });

    it('rejects cancellation for terminal succeeded, dead-lettered, and cancelled jobs', () => {
      assert.equal(isJobCancellable('succeeded'), false);
      assert.equal(isJobCancellable('dead-lettered'), false);
      assert.equal(isJobCancellable('cancelled'), false);
    });
  });

  describe('isJobRetryable & RETRYABLE_STATUS_SET', () => {
    it('allows retrying failed, dead-lettered, and cancelled jobs', () => {
      assert.equal(RETRYABLE_STATUS_SET.size, 3);
      assert.equal(isJobRetryable('failed'), true);
      assert.equal(isJobRetryable('dead-lettered'), true);
      assert.equal(isJobRetryable('cancelled'), true);
    });

    it('rejects retry for queued, scheduled, running, and succeeded jobs', () => {
      assert.equal(isJobRetryable('queued'), false);
      assert.equal(isJobRetryable('scheduled'), false);
      assert.equal(isJobRetryable('running'), false);
      assert.equal(isJobRetryable('succeeded'), false);
    });
  });

  describe('computeJobsMetrics', () => {
    it('computes aggregated counts accurately from QueueStatsResponse', () => {
      const stats: QueueStatsResponse = {
        totals: {
          queued: 10,
          scheduled: 5,
          running: 3,
          succeeded: 120,
          failed: 4,
          deadLettered: 2,
          cancelled: 6,
        },
        queues: [
          {
            name: 'default',
            depth: 10,
            inFlight: 3,
            succeeded24h: 120,
            failed24h: 4,
            deadLettered24h: 2,
          },
        ],
      };

      const metrics = computeJobsMetrics(stats);
      assert.equal(metrics.total, 150);
      assert.equal(metrics.active, 18); // 10 queued + 5 scheduled + 3 running
      assert.equal(metrics.queued, 10);
      assert.equal(metrics.scheduled, 5);
      assert.equal(metrics.running, 3);
      assert.equal(metrics.succeeded, 120);
      assert.equal(metrics.failed, 4);
      assert.equal(metrics.deadLettered, 2);
      assert.equal(metrics.cancelled, 6);
    });

    it('handles missing or undefined stats with fallbackTotal', () => {
      const metrics = computeJobsMetrics(undefined, 42);
      assert.equal(metrics.total, 42);
      assert.equal(metrics.active, 0);
      assert.equal(metrics.running, 0);
      assert.equal(metrics.failed, 0);
    });
  });

  describe('mapTabToStatuses & inferTabFromStatuses', () => {
    it('maps tabs to correct API statuses', () => {
      assert.deepEqual(mapTabToStatuses('all'), undefined);
      assert.deepEqual(mapTabToStatuses('active'), [
        'queued',
        'running',
        'scheduled',
      ]);
      assert.deepEqual(mapTabToStatuses('queued'), ['queued']);
      assert.deepEqual(mapTabToStatuses('running'), ['running']);
      assert.deepEqual(mapTabToStatuses('scheduled'), ['scheduled']);
      assert.deepEqual(mapTabToStatuses('failed'), ['failed']);
      assert.deepEqual(mapTabToStatuses('dead-lettered'), ['dead-lettered']);
      assert.deepEqual(mapTabToStatuses('succeeded'), ['succeeded']);
      assert.deepEqual(mapTabToStatuses('cancelled'), ['cancelled']);
    });

    it('infers tab from URL query statuses correctly', () => {
      assert.equal(inferTabFromStatuses([]), 'all');
      assert.equal(
        inferTabFromStatuses(['queued', 'running', 'scheduled']),
        'active',
      );
      assert.equal(inferTabFromStatuses(['running']), 'running');
      assert.equal(inferTabFromStatuses(['dead-lettered']), 'dead-lettered');
      assert.equal(inferTabFromStatuses(['failed']), 'failed');
      assert.equal(inferTabFromStatuses(['queued']), 'queued');
      assert.equal(inferTabFromStatuses(['scheduled']), 'scheduled');
      assert.equal(inferTabFromStatuses(['succeeded']), 'succeeded');
      assert.equal(inferTabFromStatuses(['cancelled']), 'cancelled');
      // Arbitrary multi-select returns all as fallback tab
      assert.equal(inferTabFromStatuses(['queued', 'failed']), 'all');
    });
  });

  describe('extractQueueOptions', () => {
    it('extracts unique and sorted queues with default included', () => {
      const queues = [
        { name: 'billing' },
        { name: 'notifications' },
        { name: 'default' },
      ];
      const result = extractQueueOptions(queues, 'custom-queue');
      assert.deepEqual(result, [
        'billing',
        'custom-queue',
        'default',
        'notifications',
      ]);
    });

    it('handles empty queue list', () => {
      const result = extractQueueOptions([]);
      assert.deepEqual(result, ['default']);
    });

    it('handles undefined queue list safely', () => {
      const result = extractQueueOptions(undefined);
      assert.deepEqual(result, ['default']);
    });
  });

  describe('getPriorityMeta', () => {
    it('returns high for priority >= 8', () => {
      const meta = getPriorityMeta(9);
      assert.equal(meta.label, 'P9 High');
      assert.equal(meta.tone, 'high');
    });

    it('returns normal for priority between 4 and 7', () => {
      const meta = getPriorityMeta(5);
      assert.equal(meta.label, 'P5');
      assert.equal(meta.tone, 'normal');
    });

    it('returns low for priority <= 3', () => {
      const meta = getPriorityMeta(2);
      assert.equal(meta.label, 'P2 Low');
      assert.equal(meta.tone, 'low');
    });
  });

  describe('formatPayloadSummary', () => {
    it('formats plain strings and truncates if necessary', () => {
      assert.equal(formatPayloadSummary('short payload', 50), 'short payload');
      assert.equal(
        formatPayloadSummary(
          'this is a very long text string that should be cut off',
          20,
        ),
        'this is a very long …',
      );
    });

    it('formats objects as json strings', () => {
      assert.equal(
        formatPayloadSummary({ url: 'https://example.com' }, 50),
        '{"url":"https://example.com"}',
      );
    });

    it('handles null and undefined', () => {
      assert.equal(formatPayloadSummary(null), '—');
      assert.equal(formatPayloadSummary(undefined), '—');
    });
  });

  describe('formatAttemptRatio', () => {
    it('formats attempt ratio cleanly', () => {
      assert.equal(formatAttemptRatio(1, 3), '1 / 3');
      assert.equal(formatAttemptRatio(3, 3), '3 / 3');
    });
  });

  describe('validateJsonString', () => {
    it('validates correct JSON object or array', () => {
      const res1 = validateJsonString('{"url": "https://api.test"}');
      assert.equal(res1.valid, true);
      assert.deepEqual(res1.parsed, { url: 'https://api.test' });

      const res2 = validateJsonString('[1, 2, 3]');
      assert.equal(res2.valid, true);
      assert.deepEqual(res2.parsed, [1, 2, 3]);
    });

    it('rejects primitives, empty strings, and invalid syntax', () => {
      const res1 = validateJsonString('   ');
      assert.equal(res1.valid, false);

      const res2 = validateJsonString('not json');
      assert.equal(res2.valid, false);

      const res3 = validateJsonString('123'); // primitive number, not object/array
      assert.equal(res3.valid, false);
    });
  });
});
