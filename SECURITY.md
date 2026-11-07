# Security Policy

## Supported versions

Veyra is pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub's private vulnerability reporting:
<https://github.com/Aniket-lodh/veyra/security/advisories/new>

Include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The commit SHA or version you tested.

You can expect an acknowledgement within 7 days. Once a fix is ready, we will
coordinate disclosure with you and credit you in the release notes unless you
prefer otherwise.

## Scope notes

- Credentials (SMTP, database, API keys) belong in environment variables or a
  secrets manager on the worker and API, never in job payloads. Payloads are
  stored in plain text in Postgres.
- **Auth.** Operators use email/password sessions. Machine clients use API keys
  from the dashboard. Passwords are bcrypt-hashed; API key secrets are stored
  as SHA-256 digests only. Never put secrets in query strings, frontend builds, or git.
- The `/internal/*` debug routes require the `debug` scope **and** the production
  nginx overlay blocks them at the edge. Do not expose them publicly.
