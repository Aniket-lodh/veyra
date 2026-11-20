import type { Worker } from './types';
import {
  computeFleetMetrics,
  extractAllQueues,
  filterAndSortWorkers,
  formatDurationMs,
  formatLeaseTimeRemaining,
  formatUptime,
  getHeartbeatOverdueDurationMs,
  getWorkerLifecycle,
  getWorkerStatusBadgeProps,
  isHeartbeatStale,
} from './workers-helpers.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('workers-helpers', () => {
  const fixedNow = 1700000000000;

  const mockWorker = (overrides: Partial<Worker> = {}): Worker => ({
    id: '01HQ6GZ6K0N1P4X5Y8Z9ABCDEF',
    hostname: 'worker-node-1.internal',
    pid: 12345,
    version: 'v1.4.0',
    state: 'active',
    startedAt: new Date(fixedNow - 3600000).toISOString(), // 1 hour ago
    lastHeartbeatAt: new Date(fixedNow - 5000).toISOString(), // 5s ago
    heartbeatIntervalSeconds: 10,
    queues: ['default', 'billing'],
    handlers: ['process-payment', 'send-invoice'],
    maxConcurrency: 8,
    inFlight: 2,
    totalProcessed: 1420,
    leases: [],
    ...overrides,
  });

  describe('isHeartbeatStale & getHeartbeatOverdueDurationMs', () => {
    it('returns false when heartbeat is fresh within interval', () => {
      // Last beat 5s ago, interval 10s -> threshold 30s
      assert.equal(
        isHeartbeatStale(new Date(fixedNow - 5000).toISOString(), 10, fixedNow),
        false,
      );
      assert.equal(
        getHeartbeatOverdueDurationMs(
          new Date(fixedNow - 5000).toISOString(),
          10,
          fixedNow,
        ),
        0,
      );
    });

    it('returns false when heartbeat is at or under 3x threshold', () => {
      // Last beat 29s ago, interval 10s -> threshold 30s
      assert.equal(
        isHeartbeatStale(
          new Date(fixedNow - 29000).toISOString(),
          10,
          fixedNow,
        ),
        false,
      );
    });

    it('returns true and overdue duration when heartbeat exceeds 3x threshold', () => {
      // Last beat 45s ago, interval 10s -> threshold 30s (overdue by 15s)
      assert.equal(
        isHeartbeatStale(
          new Date(fixedNow - 45000).toISOString(),
          10,
          fixedNow,
        ),
        true,
      );
      assert.equal(
        getHeartbeatOverdueDurationMs(
          new Date(fixedNow - 45000).toISOString(),
          10,
          fixedNow,
        ),
        15000,
      );
    });

    it('handles invalid timestamps safely', () => {
      assert.equal(isHeartbeatStale('invalid-date', 10, fixedNow), false);
      assert.equal(
        getHeartbeatOverdueDurationMs('invalid-date', 10, fixedNow),
        0,
      );
    });
  });

  describe('getWorkerLifecycle', () => {
    it('returns "disconnected" if state is disconnected even if heartbeat is stale', () => {
      const w = mockWorker({
        state: 'disconnected',
        lastHeartbeatAt: new Date(fixedNow - 100000).toISOString(),
      });
      assert.equal(getWorkerLifecycle(w, fixedNow), 'disconnected');
    });

    it('returns "stale" when non-disconnected worker heartbeat exceeds 3x interval', () => {
      const w = mockWorker({
        state: 'active',
        inFlight: 3,
        lastHeartbeatAt: new Date(fixedNow - 40000).toISOString(), // 40s > 30s
        heartbeatIntervalSeconds: 10,
      });
      assert.equal(getWorkerLifecycle(w, fixedNow), 'stale');
    });

    it('returns "draining" when worker state is draining and heartbeat is fresh', () => {
      const w = mockWorker({
        state: 'draining',
        inFlight: 1,
        lastHeartbeatAt: new Date(fixedNow - 4000).toISOString(),
        heartbeatIntervalSeconds: 10,
      });
      assert.equal(getWorkerLifecycle(w, fixedNow), 'draining');
    });

    it('returns "busy" when healthy worker has inFlight > 0', () => {
      const w = mockWorker({
        state: 'active',
        inFlight: 2,
        lastHeartbeatAt: new Date(fixedNow - 4000).toISOString(),
        heartbeatIntervalSeconds: 10,
      });
      assert.equal(getWorkerLifecycle(w, fixedNow), 'busy');
    });

    it('returns "idle" when healthy worker has inFlight === 0', () => {
      const w = mockWorker({
        state: 'active',
        inFlight: 0,
        lastHeartbeatAt: new Date(fixedNow - 4000).toISOString(),
        heartbeatIntervalSeconds: 10,
      });
      assert.equal(getWorkerLifecycle(w, fixedNow), 'idle');
    });
  });

  describe('getWorkerStatusBadgeProps', () => {
    it('returns correct visual tone and label for each status', () => {
      assert.equal(getWorkerStatusBadgeProps('busy').tone, 'success');
      assert.equal(getWorkerStatusBadgeProps('busy').label, 'Busy');

      assert.equal(getWorkerStatusBadgeProps('idle').tone, 'neutral');
      assert.equal(getWorkerStatusBadgeProps('idle').label, 'Idle');

      assert.equal(getWorkerStatusBadgeProps('draining').tone, 'info');
      assert.equal(getWorkerStatusBadgeProps('draining').label, 'Draining');

      assert.equal(getWorkerStatusBadgeProps('stale').tone, 'warning');
      assert.equal(
        getWorkerStatusBadgeProps('stale').label,
        'Degraded (Stale)',
      );

      assert.equal(getWorkerStatusBadgeProps('disconnected').tone, 'danger');
      assert.equal(
        getWorkerStatusBadgeProps('disconnected').label,
        'Disconnected',
      );
    });
  });

  describe('computeFleetMetrics (Accurate Capacity Math)', () => {
    it('computes metrics accurately and EXCLUDES disconnected workers from totalCapacity', () => {
      const workers: Worker[] = [
        // 1. Busy healthy worker
        mockWorker({
          id: 'w1',
          state: 'active',
          maxConcurrency: 8,
          inFlight: 4,
          lastHeartbeatAt: new Date(fixedNow - 2000).toISOString(),
          heartbeatIntervalSeconds: 10,
        }),
        // 2. Idle healthy worker
        mockWorker({
          id: 'w2',
          state: 'active',
          maxConcurrency: 4,
          inFlight: 0,
          lastHeartbeatAt: new Date(fixedNow - 3000).toISOString(),
          heartbeatIntervalSeconds: 10,
        }),
        // 3. Stale degraded worker
        mockWorker({
          id: 'w3',
          state: 'active',
          maxConcurrency: 4,
          inFlight: 1,
          lastHeartbeatAt: new Date(fixedNow - 60000).toISOString(), // stale!
          heartbeatIntervalSeconds: 10,
        }),
        // 4. Disconnected worker (must NOT count towards capacity or activeFleetWorkers)
        mockWorker({
          id: 'w4',
          state: 'disconnected',
          maxConcurrency: 16,
          inFlight: 0,
          lastHeartbeatAt: new Date(fixedNow - 300000).toISOString(),
          heartbeatIntervalSeconds: 10,
        }),
      ];

      const metrics = computeFleetMetrics(workers, fixedNow);

      assert.equal(metrics.totalWorkers, 4);
      assert.equal(metrics.busyWorkers, 1);
      assert.equal(metrics.idleWorkers, 1);
      assert.equal(metrics.staleWorkers, 1);
      assert.equal(metrics.disconnectedWorkers, 1);
      assert.equal(metrics.activeFleetWorkers, 3); // w1 + w2 + w3 (excludes w4)

      // Total capacity should be 8 (w1) + 4 (w2) + 4 (w3) = 16 (EXCLUDES w4's 16 slots)
      assert.equal(metrics.totalCapacity, 16);

      // Total in-flight is 4 (w1) + 0 (w2) + 1 (w3) = 5
      assert.equal(metrics.totalInFlight, 5);

      // Utilization is (5 / 16) * 100 = 31.25% -> rounded to 31.3%
      assert.equal(metrics.utilizationPct, 31.3);
    });

    it('handles empty fleet gracefully', () => {
      const metrics = computeFleetMetrics([], fixedNow);
      assert.equal(metrics.totalWorkers, 0);
      assert.equal(metrics.activeFleetWorkers, 0);
      assert.equal(metrics.totalCapacity, 0);
      assert.equal(metrics.totalInFlight, 0);
      assert.equal(metrics.utilizationPct, 0);
    });
  });

  describe('extractAllQueues', () => {
    it('returns unique sorted queues', () => {
      const workers = [
        mockWorker({ queues: ['default', 'billing'] }),
        mockWorker({ queues: ['billing', 'notifications', 'default'] }),
        mockWorker({ queues: ['analytics'] }),
      ];
      assert.deepEqual(extractAllQueues(workers), [
        'analytics',
        'billing',
        'default',
        'notifications',
      ]);
    });
  });

  describe('filterAndSortWorkers', () => {
    const wBusy = mockWorker({
      id: 'w_busy',
      hostname: 'api-worker-alpha',
      pid: 1001,
      version: 'v1.4.0',
      state: 'active',
      inFlight: 4,
      maxConcurrency: 4,
      queues: ['billing'],
      totalProcessed: 500,
      lastHeartbeatAt: new Date(fixedNow - 1000).toISOString(),
    });

    const wIdle = mockWorker({
      id: 'w_idle',
      hostname: 'compute-worker-beta',
      pid: 1002,
      version: 'v1.4.1',
      state: 'active',
      inFlight: 0,
      maxConcurrency: 8,
      queues: ['default'],
      totalProcessed: 200,
      lastHeartbeatAt: new Date(fixedNow - 5000).toISOString(),
    });

    const wStale = mockWorker({
      id: 'w_stale',
      hostname: 'storage-worker-gamma',
      pid: 1003,
      version: 'v1.3.9',
      state: 'active',
      inFlight: 1,
      maxConcurrency: 2,
      queues: ['billing', 'storage'],
      totalProcessed: 800,
      lastHeartbeatAt: new Date(fixedNow - 60000).toISOString(), // > 3x 10s
    });

    const wDisconnected = mockWorker({
      id: 'w_disc',
      hostname: 'retired-worker-delta',
      pid: 1004,
      version: 'v1.2.0',
      state: 'disconnected',
      inFlight: 0,
      maxConcurrency: 4,
      queues: ['default'],
      totalProcessed: 1200,
      lastHeartbeatAt: new Date(fixedNow - 300000).toISOString(),
    });

    const all = [wBusy, wIdle, wStale, wDisconnected];

    it('filters by status tab', () => {
      assert.deepEqual(
        filterAndSortWorkers(all, { tab: 'all', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_busy', 'w_idle', 'w_stale', 'w_disc'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { tab: 'busy', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_busy'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { tab: 'idle', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_idle'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { tab: 'stale', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_stale'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { tab: 'disconnected', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_disc'],
      );
    });

    it('filters by queue', () => {
      assert.deepEqual(
        filterAndSortWorkers(all, { queue: 'billing', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_busy', 'w_stale'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { queue: 'default', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_idle', 'w_disc'],
      );
    });

    it('searches by hostname, worker id, pid, or version', () => {
      assert.deepEqual(
        filterAndSortWorkers(all, { query: 'alpha', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_busy'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { query: 'w_idle', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_idle'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { query: '1003', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_stale'],
      );
      assert.deepEqual(
        filterAndSortWorkers(all, { query: 'v1.4.1', now: fixedNow }).map(
          (w) => w.id,
        ),
        ['w_idle'],
      );
    });

    it('sorts by utilization, processed, and hostname', () => {
      // utilization_desc: wBusy (4/4 = 100%), wStale (1/2 = 50%), wIdle (0%), wDisconnected (0%)
      const byUtil = filterAndSortWorkers(all, {
        sortBy: 'utilization_desc',
        now: fixedNow,
      });
      assert.equal(byUtil[0].id, 'w_busy');
      assert.equal(byUtil[1].id, 'w_stale');

      // processed_desc: wDisconnected (1200), wStale (800), wBusy (500), wIdle (200)
      const byProcessed = filterAndSortWorkers(all, {
        sortBy: 'processed_desc',
        now: fixedNow,
      });
      assert.deepEqual(
        byProcessed.map((w) => w.id),
        ['w_disc', 'w_stale', 'w_busy', 'w_idle'],
      );

      // hostname_asc: api-worker-alpha, compute-worker-beta, retired-worker-delta, storage-worker-gamma
      const byHost = filterAndSortWorkers(all, {
        sortBy: 'hostname_asc',
        now: fixedNow,
      });
      assert.deepEqual(
        byHost.map((w) => w.id),
        ['w_busy', 'w_idle', 'w_disc', 'w_stale'],
      );
    });
  });

  describe('format helpers', () => {
    it('formats duration strings', () => {
      assert.equal(formatDurationMs(400), '0s');
      assert.equal(formatDurationMs(12000), '12s');
      assert.equal(formatDurationMs(125000), '2m 5s');
      assert.equal(formatDurationMs(3600000), '1h');
      assert.equal(formatDurationMs(90000000), '1d 1h');
    });

    it('formats uptime', () => {
      const started = new Date(fixedNow - 7200000).toISOString(); // 2h ago
      assert.equal(formatUptime(started, fixedNow), '2h');
    });

    it('formats lease remaining TTL and expired states', () => {
      const activeLease = new Date(fixedNow + 25000).toISOString(); // 25s left
      const expiredLease = new Date(fixedNow - 10000).toISOString(); // expired 10s ago

      const resActive = formatLeaseTimeRemaining(activeLease, fixedNow);
      assert.equal(resActive.expired, false);
      assert.equal(resActive.label, '25s left');

      const resExpired = formatLeaseTimeRemaining(expiredLease, fixedNow);
      assert.equal(resExpired.expired, true);
      assert.equal(resExpired.label, 'expired 10s ago');
    });
  });
});
