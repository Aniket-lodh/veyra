# @veyra/sdk

Lightweight, zero-dependency TypeScript & Node.js SDK for the [Veyra](https://github.com/Aniket-lodh/veyra) Distributed Execution Platform.

Built directly on top of Veyra's REST API and HTTP Worker Protocol. Uses native web and Node 18+ standards (`fetch`, `AbortController`, `crypto`). No native binary bindings or direct database connections required.

---

## Features

- **Client Methods:** `enqueue()`, `getJob()`, `cancelJob()`, `retryJob()`
- **Robust Worker Engine:** Automatic worker registration, background heartbeats, empty queue backoff (`204 No Content`), and transparent `404` recovery/re-registration.
- **Concurrency & Leases:** Tunable concurrency pool, automatic periodic lease renewals during execution, and instant lease termination with `AbortSignal` triggering on `409 Conflict` (lease expired or reclaimed).
- **Completion Webhooks & HMAC Verification:** Supports enqueueing jobs with `callbackUrl` and provides guidance/helpers for verifying HMAC-SHA256 signatures (`X-Veyra-Signature`).
- **Failures & Dead-Lettering:** Automatic error formatting, stack trace capture, and immediate dead-lettering via `NonRetryableError`.
- **Graceful Shutdown:** Drains in-flight jobs within a configurable timeout, cancels timers, and cleanly deregisters from the fleet.

---

## Installation

```bash
npm install @veyra/sdk
# or
pnpm add @veyra/sdk
# or
yarn add @veyra/sdk
```

---

## Client Usage

### 1. Initialize Client & Enqueue a Job

```typescript
import { VeyraClient } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
  defaultQueue: 'default',
});

// Enqueue a job with priority, backoff, and completion webhook
const job = await client.enqueue({
  queue: 'default',
  handler: 'sync_inventory',
  payload: {
    sku: 'SKU-8921',
    warehouseId: 'wh_west_1',
    quantity: 140,
  },
  priority: 7, // 0 (lowest) to 9 (highest)
  maxAttempts: 3,
  backoff: {
    kind: 'exponential',
    baseSeconds: 30,
    capSeconds: 3600,
  },
  idempotencyKey: 'inv-sync-2026-11-20-001',
  callbackUrl: 'https://api.example.com/webhooks/veyra-completion',
});

console.log('Enqueued job:', job.id, job.status);
```

### 2. Inspect, Cancel, or Retry Jobs

```typescript
// Fetch job status and attempt history
const job = await client.getJob('job_01JC...XYZ');

// Cancel an active or queued job
await client.cancelJob('job_01JC...XYZ');

// Retry a failed, cancelled, or dead-lettered job
await client.retryJob('job_01JC...XYZ');
```

---

## Distributed Worker Usage

### Running Custom Handlers with Concurrency & Leases

```typescript
import { VeyraClient, NonRetryableError } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
});

// Create managed worker
const worker = client.createWorker({
  queues: ['default', 'inventory'],
  concurrency: 5, // Concurrent jobs executed in parallel
  pollIntervalMs: 1_000, // Backoff when queue is empty (204 No Content)
  heartbeatIntervalMs: 10_000, // Worker health heartbeat
  leaseHeartbeatIntervalMs: 10_000, // In-flight lease renewal cadence
});

// Register custom handler
worker.registerHandler('sync_inventory', async (job, ctx) => {
  console.log(`Processing job ${job.id} (attempt ${ctx.attempt})`);

  // Check abort signal: aborted if another worker reclaimed or lease expired
  if (ctx.signal.aborted) {
    throw new Error('Execution aborted: lease lost or expired');
  }

  const { sku, quantity } = job.payload as { sku: string; quantity: number };

  if (!sku) {
    // Throw NonRetryableError to dead-letter immediately without retries
    throw new NonRetryableError('SKU is required');
  }

  // Execute task...
  return { updated: true, sku, quantity, processedAt: new Date().toISOString() };
});

// Start claiming and processing jobs
await worker.start();
console.log(`Worker ${worker.workerId} active and polling...`);

// Handle graceful shutdown
const shutdown = async () => {
  console.log('Draining worker and shutting down...');
  await worker.stop({ timeoutMs: 15_000 });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

---

## Completion Webhooks & HMAC Verification

When jobs are enqueued with a `callbackUrl`, Veyra delivers an HTTP POST notification upon reaching a terminal state (`succeeded`, `failed`, `dead_lettered`, or `cancelled`).

### Webhook Headers & Payload Structure

Veyra includes the following headers with each webhook dispatch:

- `Content-Type: application/json`
- `X-Veyra-Event: job.completed`
- `X-Veyra-Job-Id: <job_id>`
- `X-Veyra-Status: <status>`
- `X-Veyra-Attempt: <attempt_number>`
- `X-Veyra-Delivery-Attempt: <callback_attempt>`
- `X-Veyra-Timestamp: <iso_timestamp>`
- `X-Veyra-Signature: sha256=<hex_hmac>` (when `VEYRA_CALLBACK_SECRET` is configured on API)

### Verifying HMAC Signatures (Node.js / Express)

```typescript
import crypto from 'node:crypto';

export function verifyVeyraWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signatureHeader.slice('sha256='.length);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const actualSignature = hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(actualSignature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}
```

---

## Development & Testing

```bash
# Typecheck
pnpm typecheck

# Run unit tests
pnpm test

# Build bundle and declaration files
pnpm build
```

---

## License

[Apache-2.0](LICENSE)
