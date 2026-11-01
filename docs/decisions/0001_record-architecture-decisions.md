# 0001 — Record Architecture Decisions

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Veyra core
- **Supersedes:** —

## Context

Decisions made in the early life of a project tend to be forgotten or re-litigated. Especially in a queue/orchestration system where semantic choices (visibility, retry, ordering, exactly-once vs at-least-once) compound over years, the reasoning behind a decision is at least as important as the decision itself.

We need a lightweight, version-controlled way to record:

- the choice that was made,
- the alternatives that were considered,
- the consequences (good and bad) that we knowingly accepted,
- when and by whom.

## Decision

We will record architecturally significant decisions as **Architecture Decision Records** (ADRs) under `docs/decisions/`, following a simplified Michael Nygard template (Context / Decision / Consequences / Alternatives).

- ADRs are numbered monotonically: `NNNN_<slug>.md`.
- ADRs have a `Status`: `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, or `Rejected`.
- Once `Accepted`, an ADR is **immutable**. Changes happen by writing a new ADR that supersedes it.
- A change is "architecturally significant" if it (a) crosses a queue semantic boundary, (b) introduces a new piece of infrastructure, (c) materially changes the operational model, or (d) is something a future engineer would ask "why did we do this?" about.

The `/new-adr` slash command scaffolds a new ADR with the right number and template.

## Consequences

### Positive
- Decisions and their reasoning travel with the code, in the same review process.
- New contributors can read `docs/decisions/` and understand the *why* of the codebase.
- AI agents have a reliable source for "why" that is independent of code archaeology.

### Negative
- Some overhead per decision. The author has to write it down.
- ADRs can drift from reality if not maintained; this is mitigated by the immutability + supersession rule.

### Neutral / follow-ups
- We do not require an ADR for every change — only architecturally significant ones. Judgment lives with the author and reviewers.

## Alternatives considered

- **No formal record.** Rejected — institutional memory is unreliable, especially for a project that intends to live for years.
- **A long-form `ARCHITECTURE.md`.** Rejected — single-file architecture docs become unread and out-of-date. ADRs are append-only and small.
- **GitHub Discussions or wiki.** Rejected — decisions need to live in the same repo as the code so they version together and can be referenced from PRs.

## References

- Michael Nygard, [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
