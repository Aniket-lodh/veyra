# 0007 — Bearer API-key authentication for the HTTP API

- **Status:** Accepted (partially superseded)
- **Date:** 2026-11-07
- **Deciders:** Veyra core
- **Supersedes:** The "no authentication" posture in `docs/architecture/system-overview.md` and `README.md`.
- **Superseded in part by:** [ADR-0008](0008_operator-sessions-and-dashboard-api-keys.md)
  (operator login + removal of `VEYRA_API_KEYS` env bootstrap). Bearer API-key
  semantics for machine clients remain in force.

## Context

The Veyra HTTP API currently has no authentication. `POST /jobs` and the
operator-facing read/cancel surfaces are open to anyone who can reach the
port. The system overview already called this out as a hard gap: nobody puts
an open enqueue endpoint on the internet.

Primary callers are **machine clients** (application backends that enqueue
work) and a **trusted operator console** on the same deployment. Humans are
not third-party OAuth clients; workers talk to Postgres directly and do not
call the HTTP API for queue primitives.

Industry peers for this shape of product converge on the same answer:

- **Temporal Cloud** — API keys (and optionally mTLS) for Workers and ops
  automation; scoped service accounts; rotate with overlap.
- **Spooled** — API keys (or JWT) only via `Authorization: Bearer …`; reject
  query-string credentials (CWE-598); per-service keys with revoke.
- **Stripe / Twilio** — long-lived API keys for server-side apps; restricted
  scopes; hash/secret shown once; OAuth reserved for delegated third parties.

OIDC / SSO is valuable when the console must plug into an org IdP. That is a
separate product surface and a separate ADR. Shipping OIDC in the same change
as "close the open enqueue hole" would delay the leak-proof baseline.

## Decision

`apps/api` authenticates HTTP callers with **Bearer API keys**.

1. **Transport.** Credentials travel only in
   `Authorization: Bearer <key>`. Query-string and body credentials are
   rejected. Missing or invalid credentials yield `401`. Valid credentials
   with insufficient scope yield `403`.
2. **Key material.** Keys are high-entropy secrets of the form
   `veyra_<prefix>_<secret>`. The plaintext is shown **once** at creation
   (or supplied via env for bootstrap). At rest we store only
   `SHA-256(plaintext)` plus the public prefix used for lookup. Verification
   uses constant-time comparison of digests. SHA-256 is appropriate here
   because the secret is high-entropy; bcrypt/argon2 are for low-entropy
   passwords.
3. **Two sources of truth, one verifier.**
   - **Env bootstrap keys** (`VEYRA_API_KEYS`, comma-separated): full-access
     (`*` scope), never written to the database, intended for compose /
     secret-manager injection and break-glass ops.
   - **Database keys** (`api_keys` table): named, scoped, rotatable,
     revocable. Created and revoked through ` /api-keys` (requires
     `keys:admin` or an env key).
4. **Scopes (least privilege).**
   - `jobs:read` — `GET /jobs`, `GET /jobs/:id`
   - `jobs:write` — `POST /jobs`, `POST /jobs/:id/cancel`
   - `queue:read` — `GET /queue/stats`, `GET /workers`
   - `keys:admin` — manage database keys
   - `debug` — `/internal/debug/*`
   - `*` — all of the above (env keys; optional on DB keys)
5. **Public surface.** Only `GET /health` is unauthenticated, so load
   balancers and uptime probes keep working.
6. **Boot policy.**
   - `APP_ENV=production` (and any non-development value): refuse to listen
     if zero env keys **and** zero active database keys are configured.
   - Development: if no keys are configured, log a loud warning and leave
     the API open so local iteration still works. Setting any key closes it.
7. **Operator console.** The React SPA cannot safely embed a long-lived
   secret in the build. The console prompts the operator for an API key once
   per browser session (`sessionStorage`) and sends it as Bearer on every
   API call. Machine clients keep keys in their secret manager / env — never
   in frontend code.
8. **Observability.** Auth failures and successful principal identity
   (key id / prefix, never the secret) appear in structured logs. The raw
   `Authorization` header is never logged.
9. **Out of scope for this ADR.** OIDC/SSO, per-tenant RBAC, mTLS, rate
   limiting, IP allowlists. Nginx continues to 404 `/internal/*` at the edge
   as defence in depth; the API also requires the `debug` scope.

## Consequences

### Positive
- Enqueue and operator surfaces are closed by default once a key is set.
- Per-integration keys can be scoped and revoked without rotating the
  break-glass env key.
- Matches the mental model developers already use with Stripe / Temporal /
  cloud queue APIs.
- No new infrastructure (IdP, Redis session store). Postgres remains the
  store of record.

### Negative — accepted knowingly
- Long-lived bearer secrets are powerful; a leak is an incident until the
  key is revoked. Mitigated by hashing at rest, prefix-based lookup,
  scopes, and rotation via create-new-then-revoke-old.
- Browser-held console keys are only appropriate for **trusted operators**
  on a deployment the operator already controls. This is not a multi-tenant
  SaaS login. OIDC lands later for org IdP needs.
- Development-mode open-API when no key is set remains a footgun if someone
  ships with `APP_ENV=development`. Production boot refusal closes the
  serious case.

### Follow-ups
- Document key creation / rotation in README and SECURITY.md (same change).
- Future ADR: OIDC / SSO for the operator console, with API keys retained
  for machine clients.

## Alternatives considered

- **Single shared env secret only.** Simpler, but no per-app revoke, no
  scopes, no audit of which integration called. Rejected as the steady
  state; kept only as the bootstrap / break-glass path alongside DB keys.
- **OIDC / OAuth2 as the only mechanism.** Right for delegated human access
  and third-party apps; wrong as the *first* gate for server-to-server
  enqueue. Rejected for v1; deferred.
- **mTLS.** Strong for Worker↔Cloud links (Temporal). Our workers do not
  call the HTTP API for queue ops, and mTLS is operationally heavier for
  app backends that just want `curl -H Authorization`. Rejected for v1.
- **JWT issued by Veyra itself without an IdP.** Adds signing-key management
  without buying federation. An opaque API key already is a bearer token.
  Rejected.
