---
description: Open or create packages/queue-core/SPEC.md and walk the author through documenting a new piece of queue semantics before any implementation.
---

You are guiding the author through writing or extending the queue spec. The rule: **the spec is written before the code.** No exceptions.

## Procedure

1. **Check if `packages/queue-core/SPEC.md` exists.**
   - If not, create it with the skeleton below.
   - If it does, read it and orient yourself to the existing sections.

2. **Ask the author which semantic they're documenting.** Options:
   - Enqueue
   - Dequeue / Lease
   - Ack / Complete
   - Nack / Fail / Retry
   - Heartbeat / ExtendLease
   - Timeout / Lease expiry
   - Cancel
   - Priority / Scheduling / Delayed visibility
   - Dead-letter queue
   - Something else (let them describe it)

3. **For the chosen semantic, scaffold a section using this template:**

```markdown
## <Operation name>

### Synopsis
<One sentence describing what this operation does.>

### Inputs
- <field>: <type> — <meaning, constraints>

### Outputs
- <field>: <type> — <meaning>

### Preconditions
- <what must be true before this can be invoked>

### Postconditions (success)
- <observable state after success>

### Postconditions (failure)
- <observable state after each failure mode>

### Concurrency
- <what happens when N callers invoke this simultaneously>
- <what locks are held, for how long>

### Ordering & visibility
- <when does the change become observable to other operations>

### Edge cases
- <enumerated edge cases, each with the defined behavior>

### Verified by
- <test file path>::<test name> — covers <which postcondition>
```

4. **Do not fill in the content yourself.** Ask the author. Your job is to make sure no section is left blank when they think they're done.

5. **When the section is complete, remind them** that the implementation PR must reference this spec section (file + heading), and that `queue-spec-guardian` will be invoked on the PR.

## SPEC.md skeleton (use only if creating fresh)

```markdown
# queue-core — Specification

This document is the source of truth for Veyra's queue semantics. Implementation
follows the spec, not the other way around. Tests reference the section they verify.

Status: Living document. Changes require review.

## Conventions

- Identifiers are ULIDs unless stated otherwise.
- All timestamps are UTC, stored as `timestamptz`.
- "Visible" means "returnable by a Dequeue call."
- "In-flight" means "leased but not yet acked/nacked."

## Sections

<!-- Each subsystem gets its own ## section, following the template in the new-queue-spec command. -->
```
