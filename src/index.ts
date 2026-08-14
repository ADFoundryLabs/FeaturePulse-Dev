import express from 'express';
import dotenv from 'dotenv';
import { Webhooks } from '@octokit/webhooks';
// FIX 1: Added .js extensions and createCheckRun to imports
import { fetchPullRequestDiff, fetchIntentFile, postComment, createCheckRun, configureBranchProtection } from './services/github.js';
import { analyzeWithAI } from './services/ai.js';
import { db } from './db/index.js';
// BullMQ queue (enqueue-side) + worker consumer (runs in-process on Render free tier)
import { prAnalysisQueue } from './queue/index.js';
import { startWorker } from './worker.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001; // Default 3001 to avoid collision with Next.js dashboard on 3000

// Initialize Webhook Handler
const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET as string,
});

// 0. Health check — must be first, no DB or Redis dependency.
//    External pingers (e.g. UptimeRobot) hit this to keep Render from idling.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 1. The Webhook Listener Route (Modified for Raw Body)
app.use('/api/webhook', (req, res, next) => {
    console.log(`\n\n🎯 [DEBUG] HTTP request received at /api/webhook. Method: ${req.method}`);
    next();
}, express.text({ type: 'application/json' }), (req: any, res) => {
    const signature = req.headers["x-hub-signature-256"] as string;
    
    // With express.text(), req.body is the exact raw string sent by GitHub
    const rawBody = req.body;

    webhooks.verifyAndReceive({
        id: req.headers["x-github-delivery"] as string,
        name: req.headers["x-github-event"] as any,
        payload: rawBody, 
        signature: signature
    }).then(() => {
        console.log(`✅ Webhook verified successfully. Event: ${req.headers["x-github-event"]}`);
    }).catch((err) => {
        console.error("❌ Webhook verification failed:", err.message);
    });

    res.status(200).send('Webhook Received');
});

// 2. Event: PR Opened or Synchronized
// ---------------------------------------------------------------------------
webhooks.on("pull_request", (event) => {
    console.log(`\n🕵️ [DEBUG] pull_request event received with action: ${event.payload.action}`);
});

webhooks.on(["pull_request.opened", "pull_request.synchronize"], async ({ payload, id: deliveryId }) => {
    console.log(`\n🚀 [DEBUG] Inside pull_request.opened handler for PR #${payload.pull_request.number}`);
    
    const { repository, pull_request, installation } = payload;

    if (!installation) {
        console.error("❌ No installation ID found in webhook");
        return;
    }

    try {
        await prAnalysisQueue.add(
            // Job name (for BullMQ dashboard visibility; doesn't affect processing)
            `pr-analysis:${repository.full_name}#${pull_request.number}@${pull_request.head.sha.slice(0, 7)}`,
            {
                deliveryId,
                githubInstallationId: installation.id,
                owner: repository.owner.login,
                repo: repository.name,
                prNumber: pull_request.number,
                headSha: pull_request.head.sha,
                prCreatedAt: pull_request.created_at,
            }
        );
        console.log(`📥 PR #${pull_request.number} in ${repository.full_name} queued for analysis (delivery ${deliveryId}).`);
    } catch (err: any) {
        console.error(`❌ Failed to enqueue PR #${pull_request.number}:`, err);
    }
});

// 3. Event: App Installed
webhooks.on("installation.created", async ({ payload }) => {
    const { id, account } = payload.installation;
    const accountName = (account as any)?.login || "unknown"; 
    console.log(`✨ New Installation! ID: ${id}, Account: ${accountName}`);
    try {
        await db.query(
            `INSERT INTO installations (github_installation_id, account_name, repo_name, intent_text) 
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (github_installation_id) DO NOTHING`,
            [id, accountName, "global", "Default intent"]
        );
        console.log("✅ Saved installation to Railway DB");
    } catch (err) {
        console.error("❌ Database Error:", err);
    }
    // Automatically protect all repositories included in the initial installation
    const repos = payload.repositories || [];
    for (const repo of repos) {
        await configureBranchProtection(id, accountName, repo.name);
    }
});
// 3.5 Event: Repositories added to an existing installation
webhooks.on("installation_repositories.added", async ({ payload }) => {
    const { id, account } = payload.installation;
    const accountName = (account as any)?.login || "unknown"; 
    const reposAdded = payload.repositories_added || [];
    console.log(`✨ Repositories added to installation ${id}`);
    for (const repo of reposAdded) {
        await configureBranchProtection(id, accountName, repo.name);
    }
});

// 4. Event: PR Merged — record time_to_merge
// Phase 3 telemetry: fires on pull_request.closed; we only act when the PR
// was actually merged (not just closed/abandoned).
//
// NOTE: Requires "Pull requests" webhook permission at the GitHub App
// registration level. If opened/synchronize already work, closed will too —
// all actions are delivered under the same Pull requests permission.
//
// UPDATE targets (installation_id, pr_number, commit_sha) so a specific
// commit is matched, avoiding ambiguity when the same PR was force-pushed
// and analyzed multiple times (each push creates a separate row with its
// own commit_sha; only the merged commit's row is updated).
webhooks.on("pull_request.closed", async ({ payload }) => {
    const { repository, pull_request, installation } = payload;

    if (!installation) {
        console.error("❌ pull_request.closed: No installation ID found in webhook");
        return;
    }

    if (!pull_request.merged) {
        // PR was closed without merging — nothing to record
        return;
    }

    console.log(`\n🔀 PR #${pull_request.number} merged in ${repository.full_name} — recording time_to_merge`);

    try {
        // Same installation-row guard as all other handlers
        const instResult = await db.query(
            `SELECT id FROM installations WHERE github_installation_id=$1`,
            [installation.id]
        );
        if (instResult.rows.length === 0) {
            console.error(`❌ Installation row not found for github_installation_id=${installation.id}. Skipping time_to_merge update.`);
            return;
        }

        // Compute elapsed seconds from PR open to merge
        const openedAt  = new Date(pull_request.created_at).getTime();
        const mergedAt  = new Date(pull_request.merged_at as string).getTime();
        const elapsedSeconds = Math.round((mergedAt - openedAt) / 1_000);

        // Target the specific commit that was merged to avoid touching rows
        // from earlier force-pushes on the same PR number
        const result = await db.query(
            `UPDATE analysis_logs
             SET time_to_merge = $1
             WHERE installation_id = $2
               AND pr_number      = $3
               AND commit_sha     = $4`,
            [elapsedSeconds, instResult.rows[0].id, pull_request.number, pull_request.head.sha]
        );

        if (result.rowCount === 0) {
            console.warn(`⚠️ time_to_merge: no analysis_logs row found for PR #${pull_request.number} / sha ${pull_request.head.sha} — row may not exist if intent.md was missing and that path had no prior log entry, or if the event arrived before the insert completed.`);
        } else {
            console.log(`✅ time_to_merge set to ${elapsedSeconds}s for PR #${pull_request.number}`);
        }

    } catch (error) {
        console.error("❌ Error recording time_to_merge:", error);
    }
});

// 5. Event: PR Review Submitted — detect human override of a BLOCK verdict
// Phase 3 telemetry: an "override" is defined as a human approving a PR
// whose most recent FeaturePulse analysis_logs row has decision = 'BLOCK'.
// Approvals following WARN or APPROVE are not counted as overrides.
//
// NOTE: Requires "Pull request reviews" → Read-only permission at the
// GitHub App registration level. This is a SEPARATE permission from
// Pull requests and is almost certainly NOT yet enabled. You must add it
// in the GitHub App's Permissions & events settings before this handler
// receives any events. GitHub will prompt existing installation users to
// re-authorize after the permission change is saved.
webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    const { repository, pull_request, review, installation } = payload;

    if (!installation) {
        console.error("❌ pull_request_review.submitted: No installation ID found in webhook");
        return;
    }

    // Only act on explicit approvals
    if (review.state !== "approved") {
        return;
    }

    console.log(`\n👤 Review APPROVED for PR #${pull_request.number} in ${repository.full_name} — checking for override`);

    try {
        // Same installation-row guard as all other handlers
        const instResult = await db.query(
            `SELECT id FROM installations WHERE github_installation_id=$1`,
            [installation.id]
        );
        if (instResult.rows.length === 0) {
            console.error(`❌ Installation row not found for github_installation_id=${installation.id}. Skipping human_override update.`);
            return;
        }

        const installationDbId = instResult.rows[0].id;

        // Find the most recent analysis_logs row for this (installation, PR)
        const logResult = await db.query(
            `SELECT id, decision
             FROM analysis_logs
             WHERE installation_id = $1
               AND pr_number       = $2
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [installationDbId, pull_request.number]
        );

        if (logResult.rows.length === 0) {
            console.log(`ℹ️ No analysis_logs row for PR #${pull_request.number} — nothing to update`);
            return;
        }

        const latestRow = logResult.rows[0];

        // Only mark as override if the most recent verdict was BLOCK
        if (latestRow.decision !== 'BLOCK') {
            console.log(`ℹ️ PR #${pull_request.number} most recent decision was '${latestRow.decision}' (not BLOCK) — approval not counted as override`);
            return;
        }

        await db.query(
            `UPDATE analysis_logs SET human_override = true WHERE id = $1`,
            [latestRow.id]
        );
        console.log(`✅ human_override = true recorded for PR #${pull_request.number} (analysis_logs.id=${latestRow.id})`);

    } catch (error) {
        console.error("❌ Error recording human_override:", error);
    }
});

app.listen(port, () => {
  console.log(`🚀 FeaturePulse Backend running on port ${port}`);

  // Start the BullMQ worker in-process (Render free tier — single process).
  // Called here (inside the listen callback) so the HTTP server is fully ready
  // before the worker starts pulling jobs. The Worker is event-driven: it polls
  // Redis for jobs independently of incoming HTTP requests and never blocks
  // webhook response handling.
  startWorker();
});