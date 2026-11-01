# unstable-receiver

A deliberately flaky HTTP endpoint for exercising the worker's `http_request`
handler against realistic failure modes. **Workload test fixture, not a Veyra
service** — no persistence, no UI, no analytics, no management API.

## Run

In the dev stack (workers reach it at `http://unstable-receiver:8090`):

```bash
docker compose -f deployments/compose/docker-compose.yml \
               -f deployments/compose/docker-compose.receiver.yml up --build
```

Standalone (manual curl on the loopback host port):

```bash
cd scripts/stress/unstable-receiver && go run .
```

## Configure (container-wide defaults, via env)

| Env | Default | Meaning |
|-----|---------|---------|
| `RECEIVER_PORT` | `8090` | listen port |
| `RECEIVER_RATE_2XX` | `70` | relative weight of a 200 |
| `RECEIVER_RATE_4XX` | `10` | relative weight of a 400 |
| `RECEIVER_RATE_5XX` | `20` | relative weight of a 503 |
| `RECEIVER_DELAY_MS` | `0` | fixed delay before responding |
| `RECEIVER_HANG_RATE` | `0` | probability `[0,1]` of hanging until the client gives up |
| `RECEIVER_HANG_MS` | `60000` | how long a hang sleeps before a late 504 |

## Drive scenarios per-request (query params, no restart)

Override behavior for a single request — stateless request-shaping, not
management:

| Query | Effect |
|-------|--------|
| `?status=NNN` | force an exact status code (e.g. `429`, `500`) |
| `?bucket=2xx\|4xx\|5xx` | force a category → `200` / `400` / `503` |
| `?delayMs=N` | force the response delay |
| `?hang=1` | force a hang (triggers client timeout) |

Examples — point an `http_request` job's `url` at:

- `http://unstable-receiver:8090/?bucket=5xx` → retry → recovery (once a roll lands 2xx) or DLQ
- `http://unstable-receiver:8090/?bucket=4xx` → retry → DLQ
- `http://unstable-receiver:8090/?hang=1` → timeout → retry
- `http://unstable-receiver:8090/` → the configured random mix

## Delivery-identity headers

The `http_request` handler sends `X-Veyra-Job-Id` (stable across attempts),
`X-Veyra-Attempt` (increments per redelivery), and `Idempotency-Key`
(defaults to the job id). The receiver logs all three on every request, so a
retry or reclaim re-run shows the **same `jobId` with an incrementing
`attempt`** — that is how a real receiver would dedupe at-least-once
redeliveries. This fixture itself stays stateless; it only logs them.
