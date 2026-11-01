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

- `docs/architecture/system-overview.md` and `docs/architecture/job-lifecycle.md`
  rewritten to match the code. `job-lifecycle.md` moved here from `apps/api/docs/`.
- `packages/queue-core/SPEC.md` now has an Enqueue section (§0). Cancel, Failure
  classification, and the other operations are marked implemented. Each section lists its
  test coverage and gaps.
- `apps/api/docs/swagger.json` covers every route: cancel, workers, queue stats, and renew.

### Fixed

- A worker now claims only jobs for handlers it runs. Before, a job for an unregistered handler was claimed and failed as `UnknownHandler`.
- The reclaim description said the attempt counter increments on every reclaim. It increments only on an inline claim.
- The reclaim grace window is documented as a fixed 10-second constant.
- Runbook event names and container names.
- **Breaking (internal):** `ClaimNextJob` takes a `handlers` argument, and `POST /internal/debug/claim` requires a `handlers` array. Deploy the API and workers together.

### Removed

- Scaffold pages and fixture data from the operator console.
- Unused Vite template assets.
- Duplicate lifecycle docs and unreferenced soak-run logs.

## Earlier history

Development history before the first public release is not included. The public
repository starts from a single initial commit.
