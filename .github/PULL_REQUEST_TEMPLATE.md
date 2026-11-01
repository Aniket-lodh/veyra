## Summary

<!-- What does this change, and why? One concern per PR. -->

Closes #

## AI assistance

<!-- Required by AI_POLICY.md. Name the tool(s) and the extent of AI involvement, or write "None". -->

- Tool(s):
- Extent:

## Checklist

- [ ] Linked to an accepted issue (AI-assisted PRs must reference one).
- [ ] Tests added or updated. Queue-semantics tests run against real Postgres.
- [ ] `gofmt`, `go vet`, and `golangci-lint` pass for the Go modules I touched.
- [ ] `pnpm lint:check`, `pnpm typecheck`, and `pnpm build` pass if I touched the frontend.
- [ ] If queue semantics changed: `packages/queue-core/SPEC.md` is updated in this PR, and tests cite the spec section.
- [ ] If the change adds a migration: `up` and `down` exist, and the checklist in `apps/api/CLAUDE.md` is satisfied.
- [ ] Docs and `.env.example` files are updated for any new configuration.
