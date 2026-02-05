import { App } from "octokit";
import dotenv from 'dotenv';

dotenv.config();

// Initialize the GitHub App "Manager"
const app = new App({
  appId: process.env.APP_ID!,
  privateKey: process.env.PRIVATE_KEY!,
  webhooks: {
    secret: process.env.WEBHOOK_SECRET!,
  },
});

/**
 * getInstallationOctokit
 * Creates an authenticated API client for a specific installation (User/Org)
 */
async function getClient(installationId: number) {
  return await app.getInstallationOctokit(installationId);
}

/**
 * fetchPullRequestDiff
 * Gets the raw text diff of the changes in a PR.
 */
export async function fetchPullRequestDiff(installationId: number, owner: string, repo: string, prNumber: number) {
  const octokit = await getClient(installationId);
  
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: {
      format: "diff", // This tells GitHub "Give me the raw diff text, not JSON"
    },
  });

  return data as unknown as string; // diff is returned as a string
}

/**
 * fetchIntentFile
 * Looks for 'intent.md' in the .featurepulse/ folder or root.
 */
export async function fetchIntentFile(installationId: number, owner: string, repo: string) {
    const octokit = await getClient(installationId);
    
    // List of paths to check (Priority order)
    const paths = [".featurepulse/intent.md", "intent.md"];

    for (const path of paths) {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
        });

        // GitHub API returns content encoded in Base64
        if ("content" in data) {
          return Buffer.from(data.content, "base64").toString("utf-8");
        }
      } catch (err) {
        // File not found at this path, continue to next
        continue;
      }
    }

    return null; // No intent file found
}

/**
 * postComment
 * Posts the AI analysis results as a comment on the PR.
 */
export async function postComment(
    installationId: number, 
    owner: string, 
    repo: string, 
    prNumber: number, 
    body: string
) {
    const octokit = await getClient(installationId);
    
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body,
    });
}

/**
 * createCheckRun
 * Creates a formal "Pass/Fail" check on the PR.
 */
export async function createCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
  decision: 'APPROVE' | 'WARN' | 'BLOCK',
  summary: string
) {
  const octokit = await getClient(installationId);

  // FIX: Explicitly tell TypeScript this variable can ONLY be one of these 3 strings
  let conclusion: "success" | "failure" | "neutral" = 'neutral';
  
  if (decision === 'APPROVE') conclusion = 'success';
  if (decision === 'BLOCK') conclusion = 'failure';

  await octokit.rest.checks.create({
    owner,
    repo,
    name: 'FeaturePulse Guard',
    head_sha: headSha,
    status: 'completed',
    conclusion: conclusion,
    output: {
      title: `AI Decision: ${decision}`,
      summary: summary,
    }
  });
}