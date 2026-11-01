# Veyra operator console

React, TypeScript, Vite, Tailwind, and shadcn/ui. It is the operator console for the
Veyra API. The backend is the source of truth. See [`CLAUDE.md`](CLAUDE.md) for the
rules that apply to this app.

## Develop

```bash
pnpm install
VITE_API_PROXY_TARGET=http://localhost:8008 pnpm dev
```

Copy `.env.example` to `.env.local` to keep these settings. Dev requests to `/jobs`,
`/queue`, `/workers`, and `/health` are proxied to the API.

## Checks

```bash
pnpm typecheck      # TypeScript
pnpm lint:check     # ESLint and Prettier
pnpm lint:fix       # apply fixes
pnpm build          # production build to dist/
```
