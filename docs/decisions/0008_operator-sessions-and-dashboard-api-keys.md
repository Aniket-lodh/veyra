# 0008 — Operator sessions and dashboard-managed API keys

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Veyra core
- **Supersedes:** The env-bootstrap / open-development posture of
  [ADR-0007](0007_api-key-authentication.md). Bearer API keys remain the
  mechanism for machine/SDK callers; humans no longer paste keys into the
  console.

## Context

ADR-0007 closed the open enqueue hole with Bearer API keys. That is correct
for **machine clients**. It is the wrong primary UX for the **operator
console**: pasting a long-lived secret into `sessionStorage` is fragile,
and `VEYRA_API_KEYS` in `.env` is a break-glass pattern, not a product login.

Operators need:

1. A real login on first boot (create the first admin when no users exist).
2. Durable sessions so they are not kicked every few minutes.
3. A place in the dashboard to mint named API keys (with expiry or never,
   and last-used visibility) for later SDK / automation use.

## Decision

1. **Users.** Table `users`: email + bcrypt password hash + role. The first
   successful `POST /auth/signup` is allowed only while `users` is empty and
   becomes `role=admin`. Further self-service signup is closed; inviting
   more operators is a later change.
2. **Sessions.** Table `sessions` stores a hash of an opaque token. The
   plaintext token is the only value in an `HttpOnly`, `SameSite=Lax`
   cookie (`veyra_session`). TTL is 30 days with sliding renewal on use.
   No JWT; Postgres remains the session store of record.
3. **HTTP auth.** Protected routes accept **either**:
   - a valid session cookie (dashboard), or
   - `Authorization: Bearer <api-key>` (SDK / automation), with the same
     scope checks as ADR-0007.
4. **Public routes.** `GET /health`, `GET /auth/status`, `POST /auth/login`,
   `POST /auth/signup` (bootstrap only), `POST /auth/logout`.
5. **No env API keys.** `VEYRA_API_KEYS` is removed from configuration and
   examples. Keys are created only by authenticated operators via
   `POST /api-keys` (dashboard UI).
6. **API key metadata.** Name required; `expires_at` nullable means never
   expires; `last_used_at` updated on successful Bearer auth (throttled).
7. **Boot policy.** The API always starts. An empty `users` table is
   "bootstrap mode": the console shows create-admin; the rest of the API
   stays locked until someone logs in or presents a key.

## Consequences

### Positive
- Operators get a normal login; sessions persist across reloads.
- First-boot story is explicit and safe (no open API, no shared env secret).
- Machine keys stay scoped/revocable and are managed where operators already work.

### Negative — accepted knowingly
- Cookie sessions need same-site (or careful CORS) deployment; the Vite
  proxy / nginx same-origin setup already satisfies this.
- Only one bootstrap admin; adding teammates requires a future invite flow.
- bcrypt adds a small CPU cost on login (intentional).

## Alternatives considered

- **Keep paste-API-key console gate.** Rejected: poor operator UX and no
  first-user story.
- **OIDC only.** Still deferred; self-hosted first-admin password is enough.
- **JWT access tokens in localStorage.** Rejected: XSS-exfiltrable; we prefer
  HttpOnly cookies + server-side session rows.
