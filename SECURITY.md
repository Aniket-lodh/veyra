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

- Credentials (SMTP, database) belong in environment variables on the worker and
  API, never in job payloads. Payloads are stored in plain text in Postgres.
- The `/internal/*` debug routes are for development. The production nginx overlay
  blocks them. Do not expose them publicly.
