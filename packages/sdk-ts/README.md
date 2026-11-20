# @veyra/sdk

Lightweight TypeScript & Node.js SDK for the [Veyra](https://github.com/Aniket-lodh/veyra) Distributed Execution Platform.

Built directly on top of Veyra's REST API and HTTP Worker Protocol. **Zero runtime dependencies** — uses Node 18+ native web standards (`fetch`, `AbortController`, `crypto`). No PostgreSQL driver or native binary bindings required.

---

## Features

- **Client Methods:** `enqueue()`, `getJob()`, `cancelJob()`, `retryJob()`
- **Robust Worker Loop:** Auto-registration, background heartbeats, empty queue backoff (`204 No Content`), transparent `404` recovery/re-registration.
- **Lease Renewal & Protection:** Automatic periodic lease renewals while jobs execute; automatic lease renewal termination and `AbortSignal` trigger on `409 Conflict` (lease expired or reclaimed).
- **Graceful Shutdown & Draining:** Drains active workers, settles in-flight jobs, and safely deregisters.
- **Failures & Dead-Lettering:** Automatic error formatting, stack trace capture, and immediate dead-lettering via `NonRetryableError`.

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

## Quickstart

### 1. Initialize Client & Enqueue a Job

```typescript
import { VeyraClient } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
  defaultQueue: 'default',
});

// Enqueue a job
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
});

console.log('Enqueued job:', job.id, job.status);
```

### 2. Implement and Run a Distributed Worker

```typescript
import { VeyraClient, NonRetryableError } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
});

// Create worker listening to specific queues
const worker = client.createWorker({
  queues: ['default', 'inventory'],
  concurrency: 5,
});

// Register handler function
worker.registerHandler('sync_inventory', async (job, ctx) => {
  console.log(`Processing job ${job.id} (attempt ${ctx.attempt})`);

  // Check abort signal if lease lost
  if (ctx.signal.aborted) {
    throw new Error('Aborted due to lease expiration');
  }

  const { sku, quantity } = job.payload as { sku: string; quantity: number };

  if (!sku) {
    // Throw NonRetryableError to dead-letter immediately without exhausting retries
    throw new NonRetryableError('SKU is required and cannot be empty');
  }

  // Simulate business logic...
  return { updated: true, sku, quantity, processedAt: new Date().toISOString() };
});

// Start worker
await worker.start();
console.log(`Worker ${worker.workerId} active and polling for jobs...`);

// Graceful shutdown on SIGTERM / SIGINT
const shutdown = async () => {
  console.log('Shutting down worker...');
  await worker.stop({ timeoutMs: 15_000 });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```
