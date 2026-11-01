# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project does not yet follow semantic versioning. It is pre-1.0.

## [Unreleased]

### Added

- Open-source project files: LICENSE (AGPL-3.0), CONTRIBUTING, CODE_OF_CONDUCT,
  SECURITY, issue and pull request templates, CODEOWNERS, Dependabot.
- GitHub Actions: Go vet, tests, and golangci-lint for each module; queue
  integration tests on real Postgres; frontend typecheck, lint, and build;
  Docker image builds; CodeQL; gitleaks; dependency review.
- `POST /jobs/:id/cancel` and the matching operator console action. Specified in
  `packages/queue-core/SPEC.md` §6.
- `send_email` worker handler (SMTP). Credentials come from worker environment
  variables only. Failure classes are documented in `apps/worker/CLAUDE.md`.
- Retryable versus permanent failure classification (SPEC §7). Handlers can mark
  a failure permanent so it dead-letters without consuming retries.
- Per-app `.env.example` files documenting every configuration variable.

### Changed

- The operator console reads the status page URL from `VITE_STATUS_PAGE_URL`
  instead of a hard-coded address.
- The Vite dev proxy defaults to `http://localhost:8080`, matching the API default.

### Removed

- Scaffold pages and fixture data from the operator console.
- Unused Vite template assets.

## Earlier history

Development history before the first public release is not included. The public
repository starts from a single initial commit.
