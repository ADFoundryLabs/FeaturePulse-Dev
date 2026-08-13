CREATE TABLE installations (
    id SERIAL PRIMARY KEY,
    github_installation_id BIGINT UNIQUE NOT NULL,
    account_name TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    intent_text TEXT,
    mode TEXT DEFAULT 'gatekeeper'
);
CREATE TABLE analysis_logs (
    id SERIAL PRIMARY KEY,
    installation_id INT REFERENCES installations(id),
    pr_number INT NOT NULL,
    commit_sha TEXT NOT NULL,
    decision TEXT NOT NULL,
    score INT,
    created_at TIMESTAMP DEFAULT NOW(),

    -- Phase 3 telemetry columns -------------------------------------------
    -- Whether a human maintainer overrode / dismissed the AI's verdict.
    -- NULL = no override signal received yet (or feature not yet wired).
    -- Populated by a future pull_request_review / override-detection hook
    -- once the product-scope question is resolved. See Phase 3 report.
    human_override BOOLEAN DEFAULT NULL,

    -- How long from PR open to merge. NULL until pull_request.closed
    -- (merged:true) webhook is subscribed and the row is back-filled.
    -- Stored as seconds (INTEGER) rather than INTERVAL for simpler
    -- cross-platform querying; convert to INTERVAL in the app layer if needed.
    -- See Phase 3 report for the subscription and UPDATE query required.
    time_to_merge INTEGER DEFAULT NULL,

    -- Whether this analysis run was driven by a found intent.md file.
    -- FALSE = no intent.md found, neutral check run posted, analysis skipped.
    -- TRUE  = intent.md found, full AI analysis performed.
    -- Always populated for every analysis_logs row.
    used_intent_file BOOLEAN NOT NULL DEFAULT FALSE
    -- -----------------------------------------------------------------------
);

-- ---------------------------------------------------------------------------
-- Phase 4 migration: idempotency constraint for BullMQ retry safety
--
-- Run these two statements IN ORDER against the live DB before deploying
-- the Phase 4 worker. The preflight DELETE is safe to run even on a clean
-- DB (it becomes a no-op when no duplicates exist).
--
-- Step 1 — remove any duplicate (installation_id, commit_sha) pairs,
--           keeping the highest-id row (most complete — has any back-filled
--           time_to_merge / human_override values).
-- DELETE FROM analysis_logs
-- WHERE id NOT IN (
--     SELECT MAX(id)
--     FROM analysis_logs
--     GROUP BY installation_id, commit_sha
-- );
--
-- Step 2 — add the uniqueness constraint so the ON CONFLICT clause in the
--           worker INSERT can rely on it for deduplication on retry.
-- ALTER TABLE analysis_logs
--     ADD CONSTRAINT uq_analysis_logs_installation_commit
--     UNIQUE (installation_id, commit_sha);
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Enforcement Mode migration: add check constraint to mode
--
-- ALTER TABLE installations
--     ADD CONSTRAINT chk_installations_mode
--     CHECK (mode IN ('gatekeeper', 'advisory', 'silent'));
-- ---------------------------------------------------------------------------