# @aniket-lodh/veyra-sdk

Lightweight, zero-dependency TypeScript & Node.js SDK for the [Veyra](https://github.com/Aniket-lodh/veyra) Distributed Execution Platform.

Built on Veyra's REST API and HTTP worker protocol using only native web and Node 18+ standards (`fetch`, `AbortController`, Web Crypto). No runtime dependencies, no native bindings, no direct database access.

---

## Features

- **End-to-end types:** built-in handler payloads/results, custom `defineHandler` contracts, and typed enqueue → retrieve → execute → webhook flows.
- **Standard Schema validation:** works with Zod, Valibot, ArkType, or any Standard Schema v1 library. `staticSchema<T>()` gives the same types with zero runtime validation.
- **Robust worker engine:** registration, heartbeats, `204` backoff, and transparent `404` re-registration.
- **Leases:** automatic renewal, `AbortSignal` on `409` lease loss, and graceful drain.
- **Typed webhooks:** HMAC-SHA256 verification and result validation for `callbackUrl` deliveries.
- **Backwards compatible:** existing string-based `enqueue` and `registerHandler` calls keep working.

---

## Installation

```bash
npm install @aniket-lodh/veyra-sdk
# or
pnpm add @aniket-lodh/veyra-sdk
```

The package ships both module formats from one install: `import` resolves to the ESM build, `require` resolves to the CommonJS build, and each entry point carries its own type declarations. Node 18+ is required.

```ts
// ESM
import { VeyraClient, defineHandler } from '@aniket-lodh/veyra-sdk';

// CommonJS
const { VeyraClient, defineHandler } = require('@aniket-lodh/veyra-sdk');
```

---

## Client

```ts
import { VeyraClient } from '@aniket-lodh/veyra-sdk';

const client = new VeyraClient({
  baseUrl: process.env.VEYRA_API_URL ?? 'http://localhost:8080',
  apiKey: process.env.VEYRA_API_KEY ?? 'veyra_...',
  defaultQueue: 'default',
});
```

### Built-in handlers

The Go worker ships `http_request`, `send_email`. Their payloads and results are typed automatically:

```ts
const job = await client.enqueue({
  handler: 'http_request',
  payload: {
    url: 'https://api.example.com/sync',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { sku: 'SKU-8921' },
    timeoutSeconds: 15,
  },
});

// job is Job<HttpRequestPayload, HttpRequestResult>
console.log(job.result?.statusCode, job.result?.durationMs);
```

```ts
await client.enqueue({
  handler: 'send_email',
  payload: {
    to: 'user@example.com',
    subject: 'Welcome',
    text: 'Thanks for signing up.',
  },
});
```

### Inspect, cancel, retry

```ts
const job = await client.getJob('01JC...XYZ');
await client.cancelJob('01JC...XYZ');
await client.retryJob('01JC...XYZ');
```

---

## Typed custom handlers

Define a handler once and reuse it on producers, workers, and webhook consumers.

### Compile-time only (`staticSchema`)

```ts
import { defineHandler, staticSchema } from '@aniket-lodh/veyra-sdk';

const sendEmail = defineHandler({
  name: 'send_email',
  queue: 'emails',
  payload: staticSchema<{ to: string; subject: string }>(),
  result: staticSchema<{ messageId: string }>(),
});

// Producer: payload is checked, result is typed.
const job = await client.enqueue(sendEmail, {
  to: 'user@example.com',
  subject: 'Welcome',
});
// Or using the object form:
// await client.enqueue({ handler: sendEmail, payload: { to: 'user@example.com', subject: 'Welcome' } });
job.result?.messageId; // string | null
```

### Runtime validation (Standard Schema / Zod)

```ts
import { z } from 'zod';
import { defineHandler } from '@aniket-lodh/veyra-sdk';

const sendEmail = defineHandler({
  name: 'send_email',
  queue: 'emails',
  payload: z.object({ to: z.string().email(), subject: z.string() }),
  result: z.object({ messageId: z.string() }),
});

// Invalid payloads throw VeyraValidationError before the HTTP request.
await client.enqueue(sendEmail, { to: 'not-an-email', subject: 'Hi' });
```

### Minimal typing without schemas

```ts
const syncInventory = defineHandler<{ sku: string; quantity: number }, { updated: boolean }>({
  name: 'sync_inventory',
});
```

---

## Worker

```ts
import { VeyraClient, NonRetryableError } from '@aniket-lodh/veyra-sdk';

const client = new VeyraClient({ baseUrl, apiKey });
const worker = client.createWorker({
  queues: ['default', 'emails'],
  concurrency: 5,
  pollIntervalMs: 1_000,
  heartbeatIntervalMs: 10_000,
  leaseHeartbeatIntervalMs: 10_000,
});

worker.register(sendEmail, async (job, ctx) => {
  // job.payload is { to: string; subject: string }
  if (ctx.signal.aborted) throw new Error('lease lost');
  if (!job.payload.to) throw new NonRetryableError('missing recipient');

  return { messageId: await deliver(job.payload) }; // must satisfy { messageId: string }
});

await worker.start();

process.on('SIGINT', async () => {
  await worker.stop({ timeoutMs: 15_000 });
  process.exit(0);
});
```

- Payload schemas run before the callback; result schemas run before completion is reported.
- Both failures raise `VeyraValidationError` (permanent, dead-lettered immediately).
- String registration remains available: `worker.register('send_invoice', async (job) => ...)` or `worker.registerHandler(...)`.

---

## Shared handler registry

When producer and consumer live in different services, type the client/worker once:

```ts
import { VeyraClient, VeyraWorker } from '@aniket-lodh/veyra-sdk';

interface MyHandlers {
  send_email: {
    payload: { to: string; subject: string };
    result: { messageId: string };
  };
}

const client = new VeyraClient<MyHandlers>({ baseUrl, apiKey });
const job = await client.enqueue({
  handler: 'send_email', // autocompletes
  payload: { to: 'user@example.com', subject: 'Welcome' },
});
job.result?.messageId; // string | null

const worker = new VeyraWorker<MyHandlers>(client, { queues: ['emails'] });
```

Built-ins are always merged in. Unknown string handler names fall back to inferred payloads and `unknown` results.

---

## Completion webhooks

Enqueue with `callbackUrl` to receive a POST when a job reaches `succeeded`, `dead_lettered`, or `cancelled`:

```ts
await client.enqueue(sendEmail, payload, {
  callbackUrl: 'https://api.example.com/webhooks/veyra',
});
```

Veyra signs the raw body with HMAC-SHA256 when `VEYRA_CALLBACK_SECRET` is configured:

```
X-Veyra-Signature: sha256=<hex>
X-Veyra-Event: job.completed
X-Veyra-Job-Id: <jobId>
X-Veyra-Status: <status>
X-Veyra-Attempt: <attempt>
X-Veyra-Delivery-Attempt: <callbackAttempts>
X-Veyra-Timestamp: <RFC3339>
```

### Express

```ts
import express from 'express';
import { parseWebhook, verifyWebhookSignature } from '@aniket-lodh/veyra-sdk';

const app = express();

app.post(
  '/webhooks/veyra',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const signature = req.header('x-veyra-signature');

    if (!(await verifyWebhookSignature(rawBody, signature, process.env.VEYRA_CALLBACK_SECRET!))) {
      return res.status(401).send('invalid signature');
    }

    const event = await parseWebhook(rawBody, sendEmail, {
      secret: process.env.VEYRA_CALLBACK_SECRET,
      signature,
    });

    console.log(event.status, event.result?.messageId);
    res.sendStatus(204);
  }
);
```

Pass the exact raw request bytes. Re-serializing the JSON breaks the signature.

---

## Error handling

| Error | Meaning |
| --- | --- |
| `VeyraApiError` | Non-2xx response; `status`, `statusText`, `body` |
| `VeyraAuthError` | `401` / `403` |
| `VeyraNotFoundError` | `404` |
| `VeyraConflictError` | `409` |
| `LeaseLostError` | `409` caused by an expired/reclaimed lease |
| `VeyraValidationError` | Standard Schema failure; `issues`, permanent |
| `NonRetryableError` | Throw from a handler to dead-letter immediately |

---

## Development

```bash
pnpm typecheck   # source + type-level tests
pnpm build       # dist/*.js + dist/*.d.ts
pnpm test        # build, typecheck tests, run unit tests
```

---

## License

[Apache-2.0](LICENSE)
