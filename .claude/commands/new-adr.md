---
description: Scaffold a new Architecture Decision Record in docs/decisions/ with the next available number.
---

You are about to scaffold a new ADR. Follow this exact procedure.

1. **Find the next number.** List `docs/decisions/` and find the highest `NNNN_` prefix. The next ADR is `NNNN+1`, zero-padded to 4 digits.
2. **Slug the title.** From the user's argument (the topic of the ADR), produce a lowercase, kebab-cased slug. Example: "Use SKIP LOCKED for dequeue" → `use-skip-locked-for-dequeue`.
3. **Create the file** at `docs/decisions/NNNN_<slug>.md` with this content (filled in):

```markdown
# NNNN — <Title>

- **Status:** Proposed
- **Date:** <today's date, YYYY-MM-DD>
- **Deciders:** <leave blank for the author to fill>
- **Supersedes:** <leave blank or reference a prior ADR>

## Context

<What problem are we solving? What forces are at play? What constraints?>

## Decision

<The decision, stated plainly. One paragraph, max two.>

## Consequences

### Positive
- <bullet>

### Negative
- <bullet>

### Neutral / follow-ups
- <bullet>

## Alternatives considered

- **<Option A>** — <one line on why rejected>
- **<Option B>** — <one line on why rejected>

## References

- <links to discussions, prior ADRs, external docs>
```

4. **Stop after creating the file.** Do not fill in the body beyond placeholders. The author writes the content; this command only scaffolds.
5. **Report:** path of the new file, ADR number, and one-line reminder that status starts at `Proposed` and must be moved to `Accepted` via review before any code references it.

If the user gave no title argument, ask for one before creating anything.
