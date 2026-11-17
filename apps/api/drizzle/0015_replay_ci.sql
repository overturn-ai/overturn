-- 0014 is deliberately skipped: it is the commerce pack's migration, on a branch that has not
-- merged yet. Whichever lands second keeps its number; drizzle reads the journal, not the gap.
--
-- Where a replay ran. A gate wired into pull requests, still there a month later, is the
-- production signal; a replay someone ran by hand is a trial. Null for every job before this.
ALTER TABLE "replay_jobs" ADD COLUMN IF NOT EXISTS "ci" jsonb;
CREATE INDEX IF NOT EXISTS "replay_jobs_ci_project" ON "replay_jobs" ("project_id","created_at")
  WHERE "ci" IS NOT NULL;
