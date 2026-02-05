import express from 'express';
import dotenv from 'dotenv';
import { Webhooks } from '@octokit/webhooks';
import { fetchPullRequestDiff, fetchIntentFile, postComment } from './services/github';
import { analyzeWithAI } from './services/ai';
import { db } from './db/index.js'; // Note the .js extension for tsx compatibility

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Initialize Webhook Handler
const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET as string,
});

// 1. The Webhook Listener Route (Modified for Raw Body)
// We add { verify: ... } to keep the raw text for signature checking
app.use('/api/webhook', express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf.toString(); // Save the exact string GitHub sent
    }
}), (req: any, res) => {
    const signature = req.headers["x-hub-signature-256"] as string;
    
    // Verify using the RAW body, not the parsed JSON
    webhooks.verifyAndReceive({
        id: req.headers["x-github-delivery"] as string,
        name: req.headers["x-github-event"] as any,
        payload: req.rawBody, // <--- Key Change: Verify the raw string
        signature: signature
    }).catch((err) => {
        console.error("❌ Webhook verification failed:", err.message);
    });

    res.status(200).send('Webhook Received');
});

// 2. Event: PR Opened or Synchronized
webhooks.on(["pull_request.opened", "pull_request.synchronize"], async ({ payload }) => {
    // Note: 'payload' here is the parsed object provided by webhooks.on, which is safe to use
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
            console.log("⚠️ No intent.md found. Skipping analysis.");
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

        // 3. The Brain: Ask AI
        console.log("🧠 Sending to AI...");
        const analysis = await analyzeWithAI(intent, diff);
        console.log("✅ AI Analysis Complete:", analysis.decision);

        // 4. The Voice: Post Comment
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

        // 5. The Memory: Save to Database
        await db.query(
            `INSERT INTO analysis_logs (installation_id, pr_number, commit_sha, decision, score) 
             VALUES ((SELECT id FROM installations WHERE github_installation_id=$1), $2, $3, $4, $5)`,
            [installation.id, pull_request.number, pull_request.head.sha, analysis.decision, analysis.score]
        );

    } catch (error) {
        console.error("❌ Error fetching PR data:", error);
    }
});

// 3. Event: App Installed
webhooks.on("installation.created", async ({ payload }) => {
    const { id, account } = payload.installation;
    console.log(`✨ New Installation! ID: ${id}, Account: ${account.login}`);

    try {
        await db.query(
            `INSERT INTO installations (github_installation_id, account_name, repo_name, intent_text) 
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (github_installation_id) DO NOTHING`,
            [id, account.login, "global", "Default intent"]
        );
        console.log("✅ Saved installation to Railway DB");
    } catch (err) {
        console.error("❌ Database Error:", err);
    }
});

app.listen(port, () => {
  console.log(`🚀 FeaturePulse Backend running on port ${port}`);
});