import type { StatusTotals, QueueAggregate } from './api/stats';
import {
  computeSystemHealth,
  computeQueueOperationalSummary,
  filterRecentJobs,
  computePipelineSegments,
  type QueueOperationalSummary,
} from './dashboard-helpers.ts';
import type { Job, Worker } from './types';
import type { FleetMetrics } from './workers-helpers';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('dashboard-helpers', () => {
  describe('computeSystemHealth', () => {
    it('returns error state when API is unreachable', () => {
      const res = computeSystemHealth({
        isApiError: true,
        apiErrorMessage: 'Connection refused',
      });
      assert.equal(res.level, 'error');
      assert.equal(res.label, 'API Unreachable');
      assert.equal(res.badgeTone, 'danger');
      assert.match(res.summary, /Connection refused/);
      assert.equal(res.alerts.length, 1);
      assert.equal(res.alerts[0].id, 'api-error');
      assert.equal(res.alerts[0].severity, 'critical');
    });

    it('returns healthy when all metrics are nominal', () => {
      const totals: StatusTotals = {
        queued: 0,
        scheduled: 0,
        running: 1,
        succeeded: 100,
        failed: 0,
        deadLettered: 0,
        cancelled: 0,
      };
      const fleetMetrics: FleetMetrics = {
        totalWorkers: 2,
        busyWorkers: 1,
        idleWorkers: 1,
        drainingWorkers: 0,
        staleWorkers: 0,
        disconnectedWorkers: 0,
        activeFleetWorkers: 2,
        totalInFlight: 1,
        totalCapacity: 10,
        utilizationPct: 10,
      };

      const res = computeSystemHealth({
        isApiError: false,
        totals,
        fleetMetrics,
      });

      assert.equal(res.level, 'healthy');
      assert.equal(res.label, 'Healthy');
      assert.equal(res.badgeTone, 'success');
      assert.equal(res.criticalIssues.length, 0);
      assert.equal(res.warnings.length, 0);
      assert.equal(res.alerts.length, 0);
    });

    it('returns at_risk when dead-lettered jobs exist and exposes actionable alert', () => {
      const totals: StatusTotals = {
        queued: 2,
        scheduled: 0,
        running: 1,
        succeeded: 50,
        failed: 0,
        deadLettered: 3,
        cancelled: 0,
      };
      const fleetMetrics: FleetMetrics = {
        totalWorkers: 1,
        busyWorkers: 1,
        idleWorkers: 0,
        drainingWorkers: 0,
        staleWorkers: 0,
        disconnectedWorkers: 0,
        activeFleetWorkers: 1,
        totalInFlight: 1,
        totalCapacity: 5,
        utilizationPct: 20,
      };

      const res = computeSystemHealth({
        isApiError: false,
        totals,
        fleetMetrics,
      });

      assert.equal(res.level, 'at_risk');
      assert.equal(res.label, 'At Risk');
      assert.equal(res.badgeTone, 'danger');
      assert.match(res.summary, /3 dead-lettered/);
      assert.equal(res.criticalIssues.length, 1);
      assert.equal(res.alerts.length, 1);
      assert.equal(res.alerts[0].id, 'dead-lettered');
      assert.equal(res.alerts[0].severity, 'critical');
      assert.equal(res.alerts[0].actionLabel, 'Review DLQ Jobs');
      assert.match(res.alerts[0].actionHref, /dead-lettered/);
      assert.equal(res.alerts[0].secondaryAction?.label, 'Replay DLQ');
    });

    it('returns at_risk when active workers are 0 and jobs are waiting', () => {
      const totals: StatusTotals = {
        queued: 10,
        scheduled: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        deadLettered: 0,
        cancelled: 0,
      };
      const fleetMetrics: FleetMetrics = {
        totalWorkers: 0,
        busyWorkers: 0,
        idleWorkers: 0,
        drainingWorkers: 0,
        staleWorkers: 0,
        disconnectedWorkers: 0,
        activeFleetWorkers: 0,
        totalInFlight: 0,
        totalCapacity: 0,
        utilizationPct: 0,
      };

      const res = computeSystemHealth({
        isApiError: false,
        totals,
        fleetMetrics,
      });

      assert.equal(res.level, 'at_risk');
      assert.match(res.summary, /Fleet offline/);
      assert.equal(
        res.alerts.some((a) => a.id === 'fleet-offline-waiting'),
        true,
      );
    });

    it('returns degraded when stale workers or retrying jobs exist without DLQ', () => {
      const totals: StatusTotals = {
        queued: 0,
        scheduled: 0,
        running: 0,
        succeeded: 10,
        failed: 2,
        deadLettered: 0,
        cancelled: 0,
      };
      const fleetMetrics: FleetMetrics = {
        totalWorkers: 2,
        busyWorkers: 0,
        idleWorkers: 1,
        drainingWorkers: 0,
        staleWorkers: 1,
        disconnectedWorkers: 0,
        activeFleetWorkers: 2,
        totalInFlight: 0,
        totalCapacity: 10,
        utilizationPct: 0,
      };

      const res = computeSystemHealth({
        isApiError: false,
        totals,
        fleetMetrics,
      });

      assert.equal(res.level, 'degraded');
      assert.equal(res.label, 'Degraded');
      assert.equal(res.badgeTone, 'warning');
      assert.equal(res.warnings.length, 2);
      assert.equal(res.alerts.length, 2); // stale-workers, failing-jobs
      assert.equal(res.alerts[0].id, 'stale-workers');
      assert.equal(res.alerts[1].id, 'failing-jobs');
    });

    it('surfaces critical alert for unserviced queues with pending backlog', () => {
      const totals: StatusTotals = {
        queued: 5,
        scheduled: 0,
        running: 0,
        succeeded: 20,
        failed: 0,
        deadLettered: 0,
        cancelled: 0,
      };
      const fleetMetrics: FleetMetrics = {
        totalWorkers: 1,
        busyWorkers: 0,
        idleWorkers: 1,
        drainingWorkers: 0,
        staleWorkers: 0,
        disconnectedWorkers: 0,
        activeFleetWorkers: 1,
        totalInFlight: 0,
        totalCapacity: 5,
        utilizationPct: 0,
      };
      const queueSummaries: QueueOperationalSummary[] = [
        {
          name: 'reports',
          depth: 5,
          inFlight: 0,
          succeeded24h: 10,
          failed24h: 0,
          deadLettered24h: 0,
          total24h: 10,
          failureRatePct24h: 0,
          assignedWorkerCount: 0, // unserviced!
          health: 'critical',
          statusLabel: 'Unserviced Backlog',
          statusTone: 'danger',
        },
      ];

      const res = computeSystemHealth({
        isApiError: false,
        totals,
        fleetMetrics,
        queueSummaries,
      });

      assert.equal(res.level, 'at_risk');
      const unservicedAlert = res.alerts.find(
        (a) => a.id === 'unserviced-queue-reports',
      );
      assert.ok(unservicedAlert);
      assert.equal(unservicedAlert.severity, 'critical');
      assert.equal(unservicedAlert.actionLabel, "View 'reports' Jobs");
      assert.match(unservicedAlert.actionHref, /reports/);
    });
  });

  describe('computeQueueOperationalSummary', () => {
    const mockWorker: Worker = {
      id: 'w-1',
      hostname: 'worker-node-1',
      pid: 1234,
      version: '1.0.0',
      state: 'active',
      startedAt: '2026-11-20T00:00:00Z',
      lastHeartbeatAt: '2026-11-20T00:00:05Z',
      heartbeatIntervalSeconds: 5,
      queues: ['default', 'emails'],
      handlers: ['noop', 'send_email'],
      maxConcurrency: 10,
      inFlight: 2,
      totalProcessed: 500,
      leases: [],
    };

    it('computes accurate error rate and worker subscription count', () => {
      const queue: QueueAggregate = {
        name: 'default',
        depth: 5,
        inFlight: 2,
        succeeded24h: 90,
        failed24h: 8,
        deadLettered24h: 2,
      };

      const summary = computeQueueOperationalSummary(queue, [mockWorker]);

      assert.equal(summary.name, 'default');
      assert.equal(summary.assignedWorkerCount, 1);
      assert.equal(summary.total24h, 100);
      assert.equal(summary.failureRatePct24h, 10.0);
      assert.equal(summary.health, 'warning');
      assert.equal(summary.statusLabel, '10% Failed (24h)');
    });

    it('flags unserviced backlog when queue has depth but 0 assigned workers', () => {
      const queue: QueueAggregate = {
        name: 'webhooks',
        depth: 25,
        inFlight: 0,
        succeeded24h: 0,
        failed24h: 0,
        deadLettered24h: 0,
      };

      const summary = computeQueueOperationalSummary(queue, [mockWorker]);

      assert.equal(summary.assignedWorkerCount, 0);
      assert.equal(summary.health, 'critical');
      assert.equal(summary.statusLabel, 'Unserviced Backlog');
      assert.equal(summary.statusTone, 'danger');
    });

    it('marks healthy when error rate is low and assigned workers exist', () => {
      const queue: QueueAggregate = {
        name: 'emails',
        depth: 2,
        inFlight: 1,
        succeeded24h: 99,
        failed24h: 1,
        deadLettered24h: 0,
      };

      const summary = computeQueueOperationalSummary(queue, [mockWorker]);

      assert.equal(summary.health, 'healthy');
      assert.equal(summary.statusLabel, 'Healthy');
      assert.equal(summary.statusTone, 'success');
      assert.equal(summary.failureRatePct24h, 1.0);
    });

    it('safely handles zero-denominator without producing NaN or Infinity', () => {
      const queue: QueueAggregate = {
        name: 'empty-queue',
        depth: 0,
        inFlight: 0,
        succeeded24h: 0,
        failed24h: 0,
        deadLettered24h: 0,
      };

      const summary = computeQueueOperationalSummary(queue, [mockWorker]);

      assert.equal(summary.total24h, 0);
      assert.equal(summary.failureRatePct24h, 0);
      assert.equal(Number.isNaN(summary.failureRatePct24h), false);
      assert.equal(Number.isFinite(summary.failureRatePct24h), true);
    });
  });

  describe('filterRecentJobs', () => {
    const jobs: Job[] = [
      {
        id: '01JOB1',
        handler: 'noop',
        queue: 'default',
        status: 'running',
        priority: 5,
        idempotencyKey: null,
        payload: {},
        result: null,
        error: null,
        attempt: 1,
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
        enqueuedAt: '2026-11-20T00:00:00Z',
        scheduledFor: null,
        startedAt: '2026-11-20T00:00:01Z',
        completedAt: null,
        cancelledAt: null,
        deadLetteredAt: null,
        currentWorkerId: 'w-1',
        leaseExpiresAt: '2026-11-20T00:00:31Z',
        nextRetryAt: null,
        attempts: [],
      },
      {
        id: '01JOB2',
        handler: 'http_request',
        queue: 'default',
        status: 'failed',
        priority: 5,
        idempotencyKey: null,
        payload: {},
        result: null,
        error: {
          class: 'HttpError',
          message: '503 Service Unavailable',
          stackTrace: '',
          occurredAt: '2026-11-20T00:00:02Z',
        },
        attempt: 2,
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
        enqueuedAt: '2026-11-20T00:00:00Z',
        scheduledFor: null,
        startedAt: '2026-11-20T00:00:01Z',
        completedAt: null,
        cancelledAt: null,
        deadLetteredAt: null,
        currentWorkerId: null,
        leaseExpiresAt: null,
        nextRetryAt: '2026-11-20T00:01:00Z',
        attempts: [],
      },
      {
        id: '01JOB3',
        handler: 'send_email',
        queue: 'emails',
        status: 'dead-lettered',
        priority: 5,
        idempotencyKey: null,
        payload: {},
        result: null,
        error: {
          class: 'SmtpError',
          message: 'Max attempts exceeded',
          stackTrace: '',
          occurredAt: '2026-11-20T00:00:05Z',
        },
        attempt: 3,
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
        enqueuedAt: '2026-11-20T00:00:00Z',
        scheduledFor: null,
        startedAt: '2026-11-20T00:00:01Z',
        completedAt: null,
        cancelledAt: null,
        deadLetteredAt: '2026-11-20T00:00:05Z',
        currentWorkerId: null,
        leaseExpiresAt: null,
        nextRetryAt: null,
        attempts: [],
      },
      {
        id: '01JOB4',
        handler: 'noop',
        queue: 'default',
        status: 'succeeded',
        priority: 5,
        idempotencyKey: null,
        payload: {},
        result: { ok: true },
        error: null,
        attempt: 1,
        maxAttempts: 3,
        backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
        enqueuedAt: '2026-11-20T00:00:00Z',
        scheduledFor: null,
        startedAt: '2026-11-20T00:00:01Z',
        completedAt: '2026-11-20T00:00:02Z',
        cancelledAt: null,
        deadLetteredAt: null,
        currentWorkerId: null,
        leaseExpiresAt: null,
        nextRetryAt: null,
        attempts: [],
      },
    ];

    it('filters correctly by tab', () => {
      assert.equal(filterRecentJobs(jobs, 'all').length, 4);
      assert.deepEqual(
        filterRecentJobs(jobs, 'running').map((j) => j.id),
        ['01JOB1'],
      );
      assert.deepEqual(
        filterRecentJobs(jobs, 'attention').map((j) => j.id),
        ['01JOB2', '01JOB3'],
      );
    });
  });

  describe('computePipelineSegments', () => {
    it('computes exact percentages excluding 0 count statuses', () => {
      const totals: StatusTotals = {
        queued: 10,
        scheduled: 10, // waiting: 20
        running: 10,
        succeeded: 60,
        failed: 5,
        deadLettered: 5,
        cancelled: 0,
      };

      const { segments, totalJobs } = computePipelineSegments(totals);

      assert.equal(totalJobs, 100);
      assert.equal(segments.length, 5); // waiting, running, succeeded, failed, dead-lettered
      const waiting = segments.find((s) => s.id === 'waiting');
      assert.equal(waiting?.count, 20);
      assert.equal(waiting?.pct, 20.0);

      const dlq = segments.find((s) => s.id === 'dead-lettered');
      assert.equal(dlq?.count, 5);
      assert.equal(dlq?.pct, 5.0);
    });

    it('handles undefined or 0 totals gracefully', () => {
      assert.equal(computePipelineSegments(undefined).totalJobs, 0);
      assert.equal(
        computePipelineSegments({
          queued: 0,
          scheduled: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          deadLettered: 0,
          cancelled: 0,
        }).totalJobs,
        0,
      );
    });
  });
});
