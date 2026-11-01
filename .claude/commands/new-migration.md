---
description: Scaffold a new PostgreSQL migration pair (up/down) under apps/api/migrations/ with the next available number.
---

You are about to scaffold a migration. Follow this exact procedure.

1. **Find the next number.** List `apps/api/migrations/`. Find the highest `NNNN_` prefix among `.up.sql` files. The next migration is `NNNN+1`, zero-padded to 4 digits.
2. **Slug the description** from the user's argument, lowercase, kebab-cased. Example: "Add retries table" → `add-retries-table`.
3. **Create two files:**

   `apps/api/migrations/NNNN_<slug>.up.sql`:
   ```sql
   -- Migration NNNN: <human description>
   -- Date: <today YYYY-MM-DD>
   --
   -- Safety checklist (delete this block before merging):
   --   [ ] Down migration actually inverts this one.
   --   [ ] No DROP COLUMN/DROP TABLE without a prior deprecation migration.
   --   [ ] Indexes on populated tables use CREATE INDEX CONCURRENTLY.
   --   [ ] NOT NULL additions are preceded by a backfill migration.
   --   [ ] If this touches queue tables (jobs, queues, leases, attempts), the
   --       packages/queue-core spec is updated and the queue-spec-guardian agent agrees.
   --   [ ] lock_timeout is set for statements that take ACCESS EXCLUSIVE on large tables.

   BEGIN;

   -- Your DDL/DML here.

   COMMIT;
   ```

   `apps/api/migrations/NNNN_<slug>.down.sql`:
   ```sql
   -- Down migration NNNN: <human description>
   --
   -- This MUST actually invert the up migration. An empty/no-op down is a blocker.

   BEGIN;

   -- Your inverse DDL/DML here.

   COMMIT;
   ```

4. **Stop after creating the files.** Do not fill in the DDL — the author writes the schema change.
5. **Remind the user** to run `migration-reviewer` (the subagent) before opening a PR, and to invoke `queue-spec-guardian` if any of the queue tables are touched.

If the user gave no description argument, ask before creating.
