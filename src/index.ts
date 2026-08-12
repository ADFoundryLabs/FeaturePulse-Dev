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

app.listen(port, () => {
  console.log(`🚀 FeaturePulse Backend running on port ${port}`);
});