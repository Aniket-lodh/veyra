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
  <a href="https://www.npmjs.com/package/@aniket-lodh/veyra-sdk"><img alt="npm: @aniket-lodh/veyra-sdk" src="https://img.shields.io/npm/v/@aniket-lodh/veyra-sdk?color=blue&label=npm%3A%20%40aniket-lodh%2Fveyra-sdk" /></a>
  <a href="https://www.npmjs.com/package/@aniket-lodh/veyra-sdk"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40aniket-lodh%2Fveyra-sdk?color=blue&label=downloads" /></a>
  <a href="https://www.postgresql.org/"><img alt="PostgreSQL: 16+" src="https://img.shields.io/badge/PostgreSQL-16%2B-4169E1?logo=postgresql&logoColor=white" /></a>
  <a href="https://go.dev/"><img alt="Go: 1.24+" src="https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript: 5.8+" src="https://img.shields.io/badge/TypeScript-5.8%2B-3178C6?logo=typescript&logoColor=white" /></a>
  <a href="https://github.com/Aniket-lodh/veyra/actions/workflows/gitleaks.yml"><img alt="Security: Gitleaks" src="https://img.shields.io/badge/security-gitleaks-blueviolet" /></a>
  <a href="https://github.com/Aniket-lodh/veyra/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Aniket-lodh/veyra?style=social" /></a>
</p>

---

Veyra coordinates jobs, leases, retries, dead letters, and completion callbacks in a single PostgreSQL database. Workers claim jobs using `SELECT ... FOR UPDATE SKIP LOCKED`, renew their leases through heartbeats, and report execution results. An operator console streams live system state over SSE. There is no separate message broker or orchestrator to deploy or maintain.

> [!IMPORTANT]
> **Spec-First Queue Semantics**
> Unlike ad-hoc queue implementations, every queue state transition, lease heartbeat, retry backoff calculation, and dead-letter routing rule in Veyra is formally specified and verified in [`packages/queue-core/SPEC.md`](packages/queue-core/SPEC.md).

## Features

- **Transactional Queue on PostgreSQL:** Enqueue, claim, lease heartbeat, complete, fail, cancel, pause, and reclaim operations are atomic. If a worker terminates, its lease expires safely and the job is automatically reclaimed.
- **Configurable Retries & Backoff:** Exponential or fixed backoff with jitter. Handlers can designate errors as permanent via non-retryable signals to dead-letter immediately.
- **Completion Webhooks:** Outbound webhook dispatch on terminal job events (`succeeded`, `failed`, `dead_lettered`, `cancelled`) with configurable timeouts, retries, and HMAC-SHA256 payload signing.
- **Queue Controls:** Operational pause/resume per queue, bulk Dead Letter Queue (DLQ) replaying, and cancellation of in-flight or queued jobs.
- **Fleet Management:** Worker heartbeat tracking, active lease inspection, operator-initiated lease force-release, draining, cordoning, and safe deregistration.
- **First-Class TypeScript SDK (`@aniket-lodh/veyra-sdk`):** Zero-dependency TypeScript and Node.js client and worker engine with concurrency control, automatic lease renewals, and abort signals.
- **Built-in Go Worker Handlers:** `http_request` for outbound webhooks with response captures, `send_email` for SMTP delivery, and `noop` for load testing.
- **Live Operator Console:** React dashboard with zero-polling live updates powered by Postgres `NOTIFY` and Server-Sent Events (SSE) invalidation.

---

## Why Veyra?

| Dimension | Veyra | Redis Queues (BullMQ / Celery) | Dedicated Brokers (Kafka / RabbitMQ) |
|---|---|---|---|
| **Primary Datastore** | **Pure PostgreSQL** (Zero extra brokers) | In-memory Redis (risk of dual-state desync) | Complex multi-node clusters |
| **Transactional Enqueue** | ✅ Atomic with your business DB transaction | ❌ Dual-write problem (requires Outbox) | ❌ Distributed transactions required |
| **Lease & Heartbeat Model** | ✅ `SKIP LOCKED` + Active periodic renewal | ⚠️ Visibility timeouts / complex Lua scripts | ⚠️ Consumer group rebalances |
| **Dead-Letter & Webhooks** | ✅ Built-in HMAC-SHA256 webhooks + DLQ | ⚠️ Manual DLQ routing & custom webhooks | ⚠️ External webhook service needed |
| **Fleet Observability** | ✅ Live SSE Operator Console + Cordoning | ⚠️ Third-party / basic dashboard | ⚠️ Enterprise monitoring tooling |
| **Worker Ecosystem** | ✅ Go workers + TypeScript SDK | Language-locked (Node or Python) | Language-dependent clients |

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
 │  (apps/worker)              │            │  (@aniket-lodh/veyra-sdk)   │
 │  - http_request, send_email │            │  - Custom handlers          │
 │  - Heartbeats & leases      │            │  - Lease renewals & signals │
 └─────────────────────────────┘            └─────────────────────────────┘
```

- **`packages/queue-core`**: Core domain model, SQL queries, and queue primitives (claim, succeed, fail, cancel, pause/resume, DLQ replay, reclaim).
- **`apps/api`**: Public REST API, operator endpoints, SSE live notifications, and background engines (sweeper, retry scheduler, reclaim driver, callback dispatcher).
- **`apps/worker`**: Compiled Go worker executing built-in handlers (`http_request`, `send_email`, `noop`).
- **`packages/sdk-ts` (`@aniket-lodh/veyra-sdk`)**: TypeScript/Node.js SDK providing both a client for job management and a worker engine for custom business logic.
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
  sdk-ts/           Zero-dependency TypeScript SDK (@aniket-lodh/veyra-sdk)
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

### 3. Launch the Operator Console (Dev Mode)

```bash
cd apps/frontend/app
pnpm install
pnpm dev
```

Navigate to <http://localhost:5173>. On initial visit, create the admin credentials. Afterwards, generate API keys under **API Keys** in the sidebar.

---

## Production Deployment

### Option A: Production with Docker Compose (Recommended Container Stack)

Production deployments use the base compose file layered with `docker-compose.prod.yml`:

```bash
# 1. Prepare production compose environment
cp deployments/compose/.env.example deployments/compose/.env

# 2. Review and update production values in deployments/compose/.env (see Checklist below)

# 3. Launch the production stack
docker compose \
  -f deployments/compose/docker-compose.yml \
  -f deployments/compose/docker-compose.prod.yml \
  up -d --build
```

**What the production compose overlay enforces:**
* **Nginx Reverse Proxy:** Fronts the API on port `8088` (or mapped host port `80`/`443`), blocking internal debug routes (`/internal/*`) and configuring streaming for Server-Sent Events (`/events`).
* **API Port Isolation:** Removes direct host port exposure on the API container (`ports: !reset []`); API traffic only flows through Nginx.
* **Database Isolation:** Rebinds PostgreSQL to `127.0.0.1:5433` (loopback only) so administrative tools or SSH tunnels can access the database without ever publishing `5432` to the public internet (`0.0.0.0`).
* **Fleet Scaling:** Launches 3 worker replicas by default.
* **Log Rotation:** Enforces Docker `json-file` log limits (`10m`/`20m`, max 3–5 rotated files) preventing disk exhaustion.

---

### Option B: Bare-Metal / Native Production (Without Docker)

You can run Veyra directly on Linux host instances using systemd services and a standalone PostgreSQL 16+ database.

#### 1. Compile Release Binaries

```bash
# Build API binary
cd apps/api
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/veyra-api ./cmd/api

# Build Worker binary
cd ../../apps/worker
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/veyra-worker ./cmd/worker
```

#### 2. Build the Static Operator Console

```bash
cd apps/frontend/app
pnpm install
pnpm build
# Generates production static assets in apps/frontend/app/dist/
```

#### 3. Database Migrations

Ensure your PostgreSQL 16+ database exists. Migrations execute automatically every time `veyra-api` starts up against `apps/api/migrations`. Ensure the database user has schema modification permissions (`CREATE TABLE`, `CREATE INDEX`, `TRIGGER`, etc.).

#### 4. Configure Production Services (systemd)

Create service environment files (e.g. `/etc/veyra/api.env` and `/etc/veyra/worker.env`, with permissions `0600`).

**`/etc/systemd/system/veyra-api.service`**:
```ini
[Unit]
Description=Veyra Distributed Execution API
After=network.target postgresql.service

[Service]
Type=simple
User=veyra
Group=veyra
EnvironmentFile=/etc/veyra/api.env
ExecStart=/usr/local/bin/veyra-api
Restart=always
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/veyra-worker@.service`** (Template for multi-worker scaling):
```ini
[Unit]
Description=Veyra Go Worker Instance %i
After=network.target veyra-api.service

[Service]
Type=simple
User=veyra
Group=veyra
EnvironmentFile=/etc/veyra/worker.env
ExecStart=/usr/local/bin/veyra-worker
Restart=always
RestartSec=5s
TimeoutStopSec=35s

[Install]
WantedBy=multi-user.target
```

Enable and scale workers:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now veyra-api
# Start 4 concurrent worker instances
sudo systemctl enable --now veyra-worker@{1..4}
```

#### 5. Production Nginx Reverse Proxy & Ingress

Configure Nginx (or Caddy / Cloudflare) to front the API and serve the static frontend console. Crucial requirements:
1. Block `/internal/*` endpoints from external access.
2. Disable buffering on `/events` for the real-time SSE bus (`proxy_buffering off; chunked_transfer_encoding off;`).
3. Serve `dist/` with SPA fallback to `index.html`.

```nginx
upstream veyra_backend {
    server 127.0.0.1:8008;
    keepalive 32;
}

server {
    listen 80;
    server_name veyra.example.com;

    # Operator Console SPA
    root /var/www/veyra-console/dist;
    index index.html;

    # 1. NEVER expose internal debug routes
    location /internal/ {
        return 404;
    }

    # 2. SSE Invalidation Bus (Unbuffered streaming)
    location /events {
        proxy_pass http://veyra_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding off;
    }

    # 3. REST API routes
    location ~ ^/(jobs|queue|workers|health|api-keys|auth) {
        proxy_pass http://veyra_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 4. SPA Frontend Routing
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Production Configuration Checklist

Before booting in production, review and update the following settings:

| Variable | Default (Dev) | Production Target | Why It Must Change |
|---|---|---|---|
| `APP_ENV` | `development` | `production` | **Disables Swagger UI (`/docs`)**, disables debug endpoints, and enables JSON structured logs. |
| `PORT` | `8008` | `8008` (or custom) | HTTP port for the API daemon (defaults to `8008`). |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` | `localhost` / `veyra` | Cloud / Dedicated host | Point to hardened, backed-up PostgreSQL 16+ instance. |
| `DB_PASSWORD` | `veyra` | Strong secret | Replace default credentials. |
| `DB_SSLMODE` | `disable` | `require` or `verify-full` | Enforces encrypted TLS connections to PostgreSQL over networks. |
| `ENABLE_DEBUG_ENDPOINTS` | `false` (in prod) | `false` | Explicitly guards `/internal/debug/*` routes against accidental invocation. |
| `VEYRA_CALLBACK_SECRET` | *(empty)* | Random 32+ byte hex | Enables HMAC-SHA256 signature verification (`X-Veyra-Signature`) on outbound completion webhooks. |
| `LOG_LEVEL` | `info` | `info` or `warn` | Reduce log verbosity for high-throughput job pipelines. |
| `VEYRA_WORKER_FAILURE_PERCENT` | `20` | **`0`** | **CRITICAL:** Dev stack injects 20% artificial errors into `noop` tasks for chaos simulation. Set to `0` in production! |
| `VEYRA_WORKER_QUEUES` | `default` | e.g. `critical,default,reports` | Comma-delimited list of queue names this worker fleet should poll and process. |
| `VEYRA_WORKER_MAX_CONCURRENCY` | `1` | e.g. `4`–`20` | Tune based on host CPU/memory and job workload characteristics. |
| `VEYRA_SMTP_*` | *(empty)* | Real SMTP credentials | Required if running the built-in `send_email` handler. Never put credentials in job payloads. |

---

## Environment Variables

Configuration is loaded from environment variables. Refer to the corresponding `.env.example` templates:

| Service | Environment Template | Key Configurations |
|---|---|---|
| **Compose** | `deployments/compose/.env.example` | Postgres credentials, worker count, log level |
| **API** | `apps/api/.env.example` | `PORT`, `DB_*`, `ENABLE_DEBUG_ENDPOINTS`, `VEYRA_CALLBACK_*` |
| **Worker** | `apps/worker/.env.example` | `VEYRA_WORKER_QUEUES`, `VEYRA_WORKER_MAX_CONCURRENCY`, `VEYRA_SMTP_*` |
| **Frontend** | `apps/frontend/app/.env.example` | `VITE_API_PROXY_TARGET`, `VITE_STATUS_PAGE_URL` |

---

## TypeScript SDK & Worker Protocol

The [`@aniket-lodh/veyra-sdk`](https://www.npmjs.com/package/@aniket-lodh/veyra-sdk) package interacts with Veyra over HTTP without requiring direct database access.

### Installation

```bash
pnpm add @aniket-lodh/veyra-sdk
# or
npm install @aniket-lodh/veyra-sdk
# or
yarn add @aniket-lodh/veyra-sdk
```

### 1. Enqueueing Jobs with Completion Webhooks

```typescript
import { VeyraClient } from '@aniket-lodh/veyra-sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8008',
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
import { VeyraClient, NonRetryableError } from '@aniket-lodh/veyra-sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL || 'http://localhost:8008',
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

Veyra is distributed under the terms of the [GNU Affero General Public License v3.0](LICENSE). The TypeScript SDK (`@aniket-lodh/veyra-sdk`) is distributed under the [Apache-2.0 License](packages/sdk-ts/LICENSE).
