# apps/frontend/app

React + TypeScript + Vite frontend. Tailwind for styling, shadcn/ui for primitives.

## Current scope

The **backend is the source of truth**. This app is the operator console for live
API data. Do not add pages or vocabulary the API does not expose yet.

### Live surfaces (keep these)

- **Dashboard** — queue stats + workers + recent jobs
- **Jobs** list / **Job detail** — filter, inspect attempts / results / errors
- **Enqueue** — guided form for `http_request` and `send_email` → `POST /jobs`
- **Workers** list / **Worker detail** — live roster and leases

### Intentionally removed / not built

- Queues / Retries / Metrics pages (were fake or placeholder)
- Disabled “operational verb” buttons (pause, replay, drain, …)
- Fake fixtures (`fake-data.ts`) — types live in `src/lib/types.ts`

### Contract types

API response shapes live in [`src/lib/types.ts`](src/lib/types.ts)
(`Job`, `Worker`, attempts, backoff, statuses). Known worker handlers today:
`http_request`, `send_email`, `noop` (`KNOWN_HANDLERS`).

### Live operator mutations

- **Cancel job** — `POST /jobs/:id/cancel` (SPEC §6). Cancellable when
  status ∈ queued | scheduled | running | failed. Idempotent if already
  cancelled; 409 if succeeded / dead-lettered.

### Out of scope until asked

- Auth, themes, mobile polish, complex charts, advanced grids, animations
- Operator mutations still waiting on API: pause / drain / replay

## Stack

- **Package manager:** pnpm (lockfile is canonical).
- **Build:** Vite.
- **UI primitives:** shadcn/ui in `src/components/ui/`.
- **Styling:** Tailwind.
- **Data:** `@tanstack/react-query` + `src/lib/api/` (relative URLs; Vite proxies in dev).
- **Type-checking:** `pnpm typecheck` before commits that touch `.ts`/`.tsx`.

## Conventions

- Composition over configuration. Prefer shadcn + small local components.
- No new design systems (no MUI/Chakra/Mantine).
- Routes are thin; logic in hooks under `src/hooks/` or `src/lib/`.
- No `any`.

## Scripts

- `pnpm dev` — local Vite. Set `VITE_API_PROXY_TARGET` to the API origin (default `http://localhost:8080`; use `http://localhost:8008` with compose). See `.env.example`.
- `pnpm build` — production build.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm lint:check` / `pnpm prettier:check`.
