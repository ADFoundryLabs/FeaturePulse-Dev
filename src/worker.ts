// src/worker.ts
// ---------------------------------------------------------------------------
// Phase 4: BullMQ worker process.
//
// Run alongside the main server (src/index.ts) as a separate process:
//   npm run worker          (dev: tsx src/worker.ts)
//   node dist/worker.js     (prod)
//
// Processes jobs from the "pr-analysis" queue for pull_request.opened and
// pull_request.synchronize events. The webhook handler (src/index.ts) enqueues
// jobs and returns 200 immediately; this worker does all the work.
//
// Execution order per job (idempotency-safe):
//   1. DB INSERT (ON CONFLICT DO NOTHING) — source of truth for dedup
//   2. Check run POST  — skipped if a check run with deliveryId already exists
//   3. PR comment POST — skipped if the <!-- featurepulse:<sha> --> fingerprint
//                        is already present on the PR
//
// If the process crashes after step 1 but before step 3, BullMQ retries the
// job. On retry the DB guard prevents a second row; the GitHub guards prevent
// duplicate check runs or comments.
// ---------------------------------------------------------------------------

import dotenv from 'dotenv';
dotenv.config();

import { Worker, Job } from 'bullmq';
import {
  fetchPullRequestDiff,
  fetchIntentFile,
  postComment,
  createCheckRun,
  hasCheckRunForDelivery,
  findFeaturePulseComment,
  featurePulseCommentFingerprint,
} from './services/github.js';
import { analyzeWithAI } from './services/ai.js';
import { db } from './db/index.js';
import { type PRAnalysisJobData, createRedisConnection } from './queue/index.js';

// ---------------------------------------------------------------------------
// Worker processor
// ---------------------------------------------------------------------------
async function processAnalysisJob(job: Job<PRAnalysisJobData>): Promise<void> {
  const {
    deliveryId,
    githubInstallationId,
    owner,
    repo,
    prNumber,
    headSha,
  } = job.data;

  const logPrefix = `[worker][${job.id}][PR #${prNumber}@${headSha.slice(0, 7)}]`;
  console.log(`${logPrefix} Starting analysis (attempt ${job.attemptsMade + 1})`);

  // -------------------------------------------------------------------------
  // Resolve the DB installation row — same guard used in all other handlers.
  // If the row is missing something is fundamentally broken; fail the job so
  // BullMQ marks it failed (rather than silently discarding it).
  // -------------------------------------------------------------------------
  const instResult = await db.query(
    `SELECT id FROM installations WHERE github_installation_id=$1`,
    [githubInstallationId]
  );
  if (instResult.rows.length === 0) {
    throw new Error(
      `${logPrefix} Installation row not found for github_installation_id=${githubInstallationId}. ` +
      `Cannot proceed — job will not be retried (installation must exist first).`
    );
  }
  const installationDbId: number = instResult.rows[0].id;

  // -------------------------------------------------------------------------
  // Fetch intent file and PR diff.
  // -------------------------------------------------------------------------
  const intent = await fetchIntentFile(githubInstallationId, owner, repo);

  if (!intent) {
    console.log(`${logPrefix} No intent.md found — posting neutral check run and logging skip.`);

    // Step 1: DB insert first (idempotency guard).
    // ON CONFLICT means a retry after a successful insert is a safe no-op.
    await db.query(
      `INSERT INTO analysis_logs
         (installation_id, pr_number, commit_sha, decision, score, used_intent_file)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT uq_analysis_logs_installation_commit DO NOTHING`,
      [installationDbId, prNumber, headSha, 'WARN', null, false]
    );
    console.log(`${logPrefix} DB row inserted (or already existed — no-op).`);

    // Step 2: Check run — skip if already posted for this delivery.
    const checkAlreadyExists = await hasCheckRunForDelivery(
      githubInstallationId, owner, repo, headSha, deliveryId
    );
    if (checkAlreadyExists) {
      console.log(`${logPrefix} Check run already posted for delivery ${deliveryId} — skipping.`);
    } else {
      await createCheckRun(
        githubInstallationId,
        owner,
        repo,
        headSha,
        'WARN',
        'No intent.md or .featurepulse/intent.md found in this repository. FeaturePulse analysis was skipped.',
        deliveryId
      );
      console.log(`${logPrefix} Neutral check run posted.`);
    }

    // No PR comment for the no-intent-file path (check run is the signal).
    return;
  }

  console.log(`${logPrefix} Found intent.md — fetching diff.`);
  const diff = await fetchPullRequestDiff(githubInstallationId, owner, repo, prNumber);
  console.log(`${logPrefix} Diff fetched (${diff.length} chars). Sending to AI.`);

  const analysis = await analyzeWithAI(intent, diff);
  console.log(`${logPrefix} AI analysis complete: ${analysis.decision} (score ${analysis.score})`);

  // -------------------------------------------------------------------------
  // Step 1: DB insert — always first, always idempotent.
  // If this succeeds and the process crashes before step 2, a retry finds
  // the row already there and skips the insert; GitHub writes still proceed
  // (they haven't been guarded yet on this path). If step 2 already completed
  // on a prior attempt, the GitHub guards below catch that.
  // -------------------------------------------------------------------------
  await db.query(
    `INSERT INTO analysis_logs
       (installation_id, pr_number, commit_sha, decision, score, used_intent_file)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT uq_analysis_logs_installation_commit DO NOTHING`,
    [installationDbId, prNumber, headSha, analysis.decision, analysis.score, true]
  );
  console.log(`${logPrefix} DB row inserted (or already existed — no-op).`);

  // -------------------------------------------------------------------------
  // Step 2: Check run — guarded by deliveryId as external_id.
  // GitHub's Checks API stores external_id verbatim; we query it back to
  // detect a previously-posted check run for this exact webhook delivery.
  // -------------------------------------------------------------------------
  const checkAlreadyExists = await hasCheckRunForDelivery(
    githubInstallationId, owner, repo, headSha, deliveryId
  );
  if (checkAlreadyExists) {
    console.log(`${logPrefix} Check run already posted for delivery ${deliveryId} — skipping.`);
  } else {
    await createCheckRun(
      githubInstallationId,
      owner,
      repo,
      headSha,
      analysis.decision,
      analysis.summary,
      deliveryId
    );
    console.log(`${logPrefix} Check run posted.`);
  }

  // -------------------------------------------------------------------------
  // Step 3: PR comment — guarded by the <!-- featurepulse:<sha> --> fingerprint.
  // The fingerprint is embedded as a hidden HTML comment so the guard survives
  // comment edits by users (the fingerprint line isn't visible in rendered MD).
  // -------------------------------------------------------------------------
  const commentAlreadyExists = await findFeaturePulseComment(
    githubInstallationId, owner, repo, prNumber, headSha
  );
  if (commentAlreadyExists) {
    console.log(`${logPrefix} PR comment already posted for SHA ${headSha.slice(0, 7)} — skipping.`);
  } else {
    const fingerprint = featurePulseCommentFingerprint(headSha);
    const commentBody = `${fingerprint}
## ⚡ FeaturePulse Report

**Decision:** ${analysis.decision} ${analysis.decision === 'APPROVE' ? '✅' : analysis.decision === 'BLOCK' ? '🛑' : '⚠️'}
**Score:** ${analysis.score}/100

**Summary:**
${analysis.summary}

---
*Analyzed by FeaturePulse AI*`;

    await postComment(githubInstallationId, owner, repo, prNumber, commentBody);
    console.log(`${logPrefix} PR comment posted.`);
  }

  console.log(`${logPrefix} Job complete.`);
}

// ---------------------------------------------------------------------------
// Worker instance
// ---------------------------------------------------------------------------
const worker = new Worker<PRAnalysisJobData>(
  'pr-analysis',
  processAnalysisJob,
  {
    connection: createRedisConnection(),
    // Process one job at a time to stay well within GitHub App rate limits.
    // Increase concurrency only after validating rate-limit headroom.
    concurrency: 1,
  }
);

worker.on('completed', (job) => {
  console.log(`✅ [worker] Job ${job.id} completed.`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ [worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts.attempts}):`, err.message);
});

worker.on('error', (err) => {
  console.error('❌ [worker] Worker error:', err);
});

console.log('🔧 FeaturePulse worker started — listening on "pr-analysis" queue.');
