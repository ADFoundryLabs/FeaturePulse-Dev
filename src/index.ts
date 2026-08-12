import express from 'express';
import dotenv from 'dotenv';
import { Webhooks } from '@octokit/webhooks';
// FIX 1: Added .js extensions and createCheckRun to imports
import { fetchPullRequestDiff, fetchIntentFile, postComment, createCheckRun } from './services/github.js';
import { analyzeWithAI } from './services/ai.js';
import { db } from './db/index.js'; 

dotenv.config();

const app = express();
const port = process.env.PORT || 3001; // Default 3001 to avoid collision with Next.js dashboard on 3000

// Initialize Webhook Handler
const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET as string,
});

// 1. The Webhook Listener Route (Modified for Raw Body)
app.use('/api/webhook', express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf.toString(); 
    }
}), (req: any, res) => {
    const signature = req.headers["x-hub-signature-256"] as string;
    
    webhooks.verifyAndReceive({
        id: req.headers["x-github-delivery"] as string,
        name: req.headers["x-github-event"] as any,
        payload: req.rawBody, 
        signature: signature
    }).catch((err) => {
        console.error("❌ Webhook verification failed:", err.message);
    });

    res.status(200).send('Webhook Received');
});

// 2. Event: PR Opened or Synchronized
webhooks.on(["pull_request.opened", "pull_request.synchronize"], async ({ payload }) => {
    const { repository, pull_request, installation } = payload;
    
    if (!installation) {
        console.error("❌ No installation ID found in webhook");
        return;
    }

    console.log(`\n👀 Analyzing PR #${pull_request.number} in ${repository.full_name}...`);

    try {
        const intent = await fetchIntentFile(
            installation.id, 
            repository.owner.login, 
            repository.name
        );

        if (!intent) {
            console.log("⚠️ No intent.md found. Posting neutral check run and skipping analysis.");
            // PRODUCT DECISION (flagged): Option (a) implemented — post a neutral check run so the
            // PR author sees a visible signal. Confirm whether this should instead be option (b)
            // (hard-block) or remain as a neutral skip. See featurepulse-remediation-directive.md item 4.
            const sha = pull_request.head.sha;
            await createCheckRun(
                installation.id,
                repository.owner.login,
                repository.name,
                sha,
                'WARN',   // maps to 'neutral' conclusion in createCheckRun
                'No intent.md or .featurepulse/intent.md found in this repository. FeaturePulse analysis was skipped.'
            );

            // Phase 3 telemetry: log the skipped-analysis event with used_intent_file=false
            // so dashboard queries can distinguish intent-driven runs from skipped ones.
            const instResultNoIntent = await db.query(
                `SELECT id FROM installations WHERE github_installation_id=$1`,
                [installation.id]
            );
            if (instResultNoIntent.rows.length === 0) {
                console.error(`❌ Installation row not found for github_installation_id=${installation.id}. Skipping DB insert.`);
            } else {
                await db.query(
                    `INSERT INTO analysis_logs (installation_id, pr_number, commit_sha, decision, score, used_intent_file)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [instResultNoIntent.rows[0].id, pull_request.number, sha, 'WARN', null, false]
                );
            }
            return;
        }
        console.log("✅ Found Intent Rules");

        const diff = await fetchPullRequestDiff(
            installation.id, 
            repository.owner.login, 
            repository.name, 
            pull_request.number
        );
        console.log(`✅ Fetched PR Diff (${diff.length} chars)`);

        console.log("🧠 Sending to AI...");
        const analysis = await analyzeWithAI(intent, diff);
        console.log("✅ AI Analysis Complete:", analysis.decision);

        // 4. The Gatekeeper: Create a Check Run
        console.log("🛡️ Posting Check Run...");
        const sha = pull_request.head.sha; // We need the specific commit hash

        await createCheckRun(
            installation.id,
            repository.owner.login,
            repository.name,
            sha,
            analysis.decision,
            analysis.summary
        );
        console.log("✅ Check Run posted!");

        // Optional: Still post a comment so detailed breakdown is visible in chat
        const commentBody = `
## ⚡ FeaturePulse Report

**Decision:** ${analysis.decision} ${analysis.decision === 'APPROVE' ? '✅' : analysis.decision === 'BLOCK' ? '🛑' : '⚠️'}
**Score:** ${analysis.score}/100

**Summary:**
${analysis.summary}

---
*Analyzed by FeaturePulse AI*
        `;

        await postComment(
            installation.id,
            repository.owner.login,
            repository.name,
            pull_request.number,
            commentBody
        );
        console.log("✅ Comment posted to GitHub!");

        // FIX 2: Fetch installation row first; skip insert (log error) if not found to avoid null FK
        const instResult = await db.query(
            `SELECT id FROM installations WHERE github_installation_id=$1`,
            [installation.id]
        );
        if (instResult.rows.length === 0) {
            console.error(`❌ Installation row not found for github_installation_id=${installation.id}. Skipping DB insert to avoid null FK.`);
        } else {
            // Phase 3 telemetry: include used_intent_file=true (intent was found and used)
            await db.query(
                `INSERT INTO analysis_logs (installation_id, pr_number, commit_sha, decision, score, used_intent_file)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [instResult.rows[0].id, pull_request.number, sha, analysis.decision, analysis.score, true]
            );
        }

    } catch (error) {
        console.error("❌ Error fetching PR data:", error);
    }
});

// 3. Event: App Installed
webhooks.on("installation.created", async ({ payload }) => {
    const { id, account } = payload.installation;
    
    // FIX 3: Cast account to 'any' to fix the strict type error about 'login'
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
});