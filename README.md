<p align="center">
  <img src="apps/frontend/app/public/icon.png" alt="Veyra" width="96" />
</p>

<h1 align="center">Veyra</h1>

<p align="center">
  A durable distributed job queue and workflow runner built on PostgreSQL.<br />
  Queue semantics are explicit, specified, and transactional.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue" /></a>
  <a href="https://github.com/Aniket-lodh/veyra/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Aniket-lodh/veyra/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@veyra/sdk"><img alt="npm: @veyra/sdk" src="https://img.shields.io/badge/npm-%40veyra%2Fsdk-informational" /></a>
</p>

---

Veyra coordinates jobs, leases, retries, dead letters, and completion callbacks in a single PostgreSQL database. Workers claim jobs using `SELECT ... FOR UPDATE SKIP LOCKED`, renew their leases through heartbeats, and report execution results. An operator console streams live system state over SSE. There is no separate message broker or orchestrator to deploy or maintain.

Every queue state transition is formally specified in [`packages/queue-core/SPEC.md`](packages/queue-core/SPEC.md).

## Features

- **Transactional Queue on PostgreSQL:** Enqueue, claim, lease heartbeat, complete, fail, cancel, pause, and reclaim operations are atomic. If a worker terminates, its lease expires safely and the job is automatically reclaimed.
- **Configurable Retries & Backoff:** Exponential or fixed backoff with jitter. Handlers can designate errors as permanent via non-retryable signals to dead-letter immediately.
- **Completion Webhooks:** Outbound webhook dispatch on terminal job events (`succeeded`, `failed`, `dead_lettered`, `cancelled`) with configurable timeouts, retries, and HMAC-SHA256 payload signing.
- **Queue Controls:** Operational pause/resume per queue, bulk Dead Letter Queue (DLQ) replaying, and cancellation of in-flight or queued jobs.
- **Fleet Management:** Worker heartbeat tracking, active lease inspection, operator-initiated lease force-release, draining, cordoning, and safe deregistration.
- **First-Class TypeScript SDK (`@veyra/sdk`):** Zero-dependency TypeScript and Node.js client and worker engine with concurrency control, automatic lease renewals, and abort signals.
- **Built-in Go Worker Handlers:** `http_request` for outbound webhooks with response captures, `send_email` for SMTP delivery, and `noop` for load testing.
- **Live Operator Console:** React dashboard with zero-polling live updates powered by Postgres `NOTIFY` and Server-Sent Events (SSE) invalidation.

---

## Architecture Overview

```text
 ┌────────────────────────────────────────────────────────────────────────┐
 │                     Operator Console (React / Vite)                   │
 └──────────────┬──────────────────────────────────────────▲──────────────┘
                │ REST API                                 │ SSE (/events)
                ▼                                          │
 ┌─────────────────────────────────────────────────────────┴──────────────┐
 │                              Veyra API                                 │
 │   - REST Router (Go / Fiber)         - Worker Sweeper Loop             │
 │   - SSE Live Event Hub & Listener    - Retry Scheduler Loop            │
 │   - API Key & Session Auth           - Reclaim Driver Loop             │
 │   - Completion Webhook Dispatcher                                      │
 └──────────────┬──────────────────────────────────────────▲──────────────┘
                │ pgx                                      │ pgx
                ▼                                          │
 ┌─────────────────────────────────────────────────────────┴──────────────┐
 │                             PostgreSQL                                 │
 │   - jobs, job_attempts, workers, queue_states, api_keys, users         │
 │   - Transactional Primitives: SELECT ... FOR UPDATE SKIP LOCKED        │
 └──────────────▲──────────────────────────────────────────▲──────────────┘
                │ pgx                                      │ HTTP Worker Protocol
 ┌──────────────┴──────────────┐            ┌──────────────┴──────────────┐
 │        Go Workers           │            │  TypeScript SDK Workers     │
 │  (apps/worker)              │            │  (@veyra/sdk)               │
 │  - http_request, send_email │            │  - Custom handlers          │
 │  - Heartbeats & leases      │            │  - Lease renewals & signals │
 └─────────────────────────────┘            └─────────────────────────────┘
```

- **`packages/queue-core`**: Core domain model, SQL queries, and queue primitives (claim, succeed, fail, cancel, pause/resume, DLQ replay, reclaim).
- **`apps/api`**: Public REST API, operator endpoints, SSE live notifications, and background engines (sweeper, retry scheduler, reclaim driver, callback dispatcher).
- **`apps/worker`**: Compiled Go worker executing built-in handlers (`http_request`, `send_email`, `noop`).
- **`packages/sdk-ts` (`@veyra/sdk`)**: TypeScript/Node.js SDK providing both a client for job management and a worker engine for custom business logic.
- **`apps/frontend/app`**: Operator console for inspecting queues, jobs, attempts, workers, and metrics.

---

## Repository Layout

```text
apps/
  api/              Go HTTP REST API, SSE streaming, and background loops
  worker/           Go worker runtime with built-in handlers
  frontend/app/     React + Vite operator console
packages/
  queue-core/       Queue semantics, database models, and SQL primitives
  sdk-ts/           Zero-dependency TypeScript SDK (@veyra/sdk)
deployments/
  compose/          Docker Compose manifests and environment examples
  docker/           Dockerfiles (API, worker) and nginx configuration
docs/
  architecture/     System architecture and database schema specifications
  decisions/        Architecture Decision Records (ADRs)
  runbooks/         Operational runbooks
scripts/            Development, stress, chaos, and SQL administration scripts
```

---

## Local Setup & Self-Hosting

### Prerequisites

- Docker and Docker Compose
- Go 1.24+ (for local Go development)
- Node.js 18+ and pnpm (for TypeScript SDK and operator console)

### 1. Start the Local Dev Stack

```bash
git clone https://github.com/Aniket-lodh/veyra.git
cd veyra

# Prepare environment configuration
cp deployments/compose/.env.example deployments/compose/.env

# Launch Postgres, API (on port 8008), and 2 Go workers
scripts/dev/up.sh 2
```

The database volume persists across restarts. To stop the stack, run `make down`.

### 2. Database Migrations

Migrations run automatically on API startup. They are stored in `apps/api/migrations/`:

- `000001_create_jobs_table`
- `000002_create_workers_and_job_attempts`
- `000003_create_api_keys`
- `000004_create_users_and_sessions`
- `000005_ui_live_notify`
- `000006_workers_ui_notify_no_heartbeat`
- `000007_create_queue_states_table`
- `000008_add_worker_cordoned_state`
- `000009_add_job_completion_webhooks`

### 3. Launch the Operator Console

```bash
cd apps/frontend/app
pnpm install
VITE_API_PROXY_TARGET=http://localhost:8008 pnpm dev
```

Navigate to <http://localhost:5173>. On initial visit, create the admin credentials. Afterwards, generate API keys under **API Keys** in the sidebar.

---

## Environment Variables

Configuration is loaded from environment variables. Refer to the corresponding `.env.example` templates:

| Service | Environment Template | Key Configurations |
|---|---|---|
| **Compose** | `deployments/compose/.env.example` | Postgres credentials, worker count, log level |
| **API** | `apps/api/.env.example` | `PORT`, `DB_*`, `ENABLE_DEBUG_ENDPOINTS`, `VEYRA_CALLBACK_*` |
| **Worker** | `apps/worker/.env.example` | `VEYRA_WORKER_QUEUES`, `VEYRA_WORKER_MAX_CONCURRENCY`, `VEYRA_SMTP_*` |
| **Frontend** | `apps/frontend/app/.env.example` | `VITE_API_PROXY_TARGET`, `VITE_STATUS_PAGE_URL` |

> [!IMPORTANT]
> Never commit `.env` files to source control. Always update `.env.example` when introducing configuration settings.

---

## TypeScript SDK & Worker Protocol

The `@veyra/sdk` package interacts with Veyra over HTTP without requiring direct database access.

### Installation

```bash
pnpm add @veyra/sdk
```

### 1. Enqueueing Jobs with Completion Webhooks

```typescript
import { VeyraClient } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
  defaultQueue: 'default',
});

const job = await client.enqueue({
  queue: 'reports',
  handler: 'generate_pdf',
  payload: { reportId: 'rep_108', format: 'landscape' },
  priority: 5,
  maxAttempts: 3,
  backoff: { kind: 'exponential', baseSeconds: 30, capSeconds: 3600 },
  idempotencyKey: 'report-gen-rep_108',
  callbackUrl: 'https://api.example.com/webhooks/reports',
});

console.log('Enqueued job ID:', job.id);
```

### 2. Running Custom Worker Handlers

```typescript
import { VeyraClient, NonRetryableError } from '@veyra/sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY || 'veyra_...',
});

const worker = client.createWorker({
  queues: ['reports'],
  concurrency: 4,               // Max simultaneous active jobs
  pollIntervalMs: 1_000,        // Backoff interval when queue is empty (204 No Content)
  heartbeatIntervalMs: 10_000,  // Worker health heartbeat interval
  leaseHeartbeatIntervalMs: 10_000, // In-flight lease renewal cadence
});

worker.registerHandler('generate_pdf', async (job, ctx) => {
  // Check if lease was lost to abort long-running computations early
  if (ctx.signal.aborted) {
    throw new Error('Lease lost or expired; halting execution');
  }

  const { reportId } = job.payload as { reportId?: string };
  if (!reportId) {
    // Fails permanently without consuming retry budget
    throw new NonRetryableError('reportId is missing');
  }

  // Execute processing logic...
  return { generated: true, url: `https://storage.example.com/${reportId}.pdf` };
});

await worker.start();
```

### 3. Webhook Delivery & HMAC Signature Verification

When configured with `VEYRA_CALLBACK_SECRET`, Veyra signs completion webhook requests using HMAC-SHA256 and includes the digest in the `X-Veyra-Signature` header:

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
  const expectedSig = signatureHeader.slice('sha256='.length);
  const actualSig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(actualSig, 'hex'),
    Buffer.from(expectedSig, 'hex')
  );
}
```

---

## Verification & Commands

### Go Modules (`packages/queue-core`, `apps/api`, `apps/worker`)

```bash
# Run unit tests across all Go modules
cd packages/queue-core && go test ./...
cd ../../apps/api && go test ./...
cd ../../apps/worker && go test ./...

# Run queue-core integration tests against PostgreSQL (requires running database)
cd packages/queue-core && go test -tags integration -count=1 ./...

# Format and lint Go code
gofmt -w apps packages scripts
cd packages/queue-core && golangci-lint run
cd ../../apps/api && golangci-lint run
cd ../../apps/worker && golangci-lint run
```

### TypeScript SDK (`packages/sdk-ts`)

```bash
cd packages/sdk-ts

# Run tests
pnpm test

# Typecheck
pnpm typecheck

# Build distribution bundle
pnpm build
```

### Operator Console (`apps/frontend/app`)

```bash
cd apps/frontend/app

# Run test suite
pnpm test

# Typecheck
pnpm typecheck

# Lint and format checks
pnpm lint:check

# Production build
pnpm build
```

### Docker Image Builds

```bash
# Build API image
docker build -f deployments/docker/api.Dockerfile -t veyra-api:local .

# Build Worker image
docker build -f deployments/docker/worker.Dockerfile -t veyra-worker:local .
```

---

## License

Veyra is distributed under the terms of the [GNU Affero General Public License v3.0](LICENSE). The TypeScript SDK (`@veyra/sdk`) is distributed under the [Apache-2.0 License](packages/sdk-ts/LICENSE).
