import { App, Octokit } from "octokit";
import { throttling } from "@octokit/plugin-throttling";
import dotenv from 'dotenv';

dotenv.config();

// ---------------------------------------------------------------------------
// Phase 2 Fix 2 (Octokit): @octokit/plugin-throttling
// Create a custom Octokit class with the throttling plugin baked in, then
// hand it to the App constructor so every installation client produced by
// app.getInstallationOctokit() automatically gets rate-limit handling.
//
// onRateLimit  → primary rate limit (REST 429 / X-RateLimit-Remaining: 0)
// onSecondaryRateLimit → abuse / concurrency limits
//
// Returning true from these handlers tells the plugin to wait retryAfter
// seconds and automatically replay the request. We cap at 3 retries each.
// ---------------------------------------------------------------------------
const ThrottledOctokit = Octokit.plugin(throttling);

// Initialize the GitHub App "Manager"
const app = new App({
  appId: process.env.APP_ID!,
  privateKey: process.env.PRIVATE_KEY!,
  webhooks: {
    secret: process.env.WEBHOOK_SECRET!,
  },
  // Pass the throttle-enabled Octokit class with default throttle handlers.
  // These defaults are inherited by every installation client.
  Octokit: ThrottledOctokit.defaults({
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string; request: { retryCount: number } }, octokit: InstanceType<typeof ThrottledOctokit>) => {
        octokit.log.warn(
          `GitHub primary rate limit hit for ${options.method} ${options.url}. ` +
          `Retrying after ${retryAfter}s (attempt ${options.request.retryCount + 1}/3).`
        );
        // Retry up to 3 times
        return options.request.retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string; request: { retryCount: number } }, octokit: InstanceType<typeof ThrottledOctokit>) => {
        octokit.log.warn(
          `GitHub secondary rate limit (abuse) hit for ${options.method} ${options.url}. ` +
          `Retrying after ${retryAfter}s (attempt ${options.request.retryCount + 1}/3).`
        );
        return options.request.retryCount < 3;
      },
    },
  }),
});

/**
 * getInstallationOctokit
 * Creates an authenticated API client for a specific installation (User/Org).
 * The client inherits the throttling plugin configured above.
 */
async function getClient(installationId: number) {
  return await app.getInstallationOctokit(installationId);
}

// ---------------------------------------------------------------------------
// Phase 2 Fix 3: In-memory intent.md cache
//
// fetchIntentFile previously issued a fresh getContent request on every
// pull_request event. On an active repo receiving many events this burns
// rate-limit quota needlessly (the file changes rarely).
//
// Cache design:
//   - Key:    "<owner>/<repo>" (ref is intentionally omitted — intent.md is
//             expected to live on the default branch and change infrequently)
//   - Value:  { content: string | null, expiresAt: number (epoch ms) }
//   - TTL:    3 minutes — short enough to pick up changes between PRs on an
//             active repo; long enough to cut duplicate calls in burst traffic
//
// The cache is process-local (Map). If/when Phase 4 adds Redis this can be
// swapped for a shared cache without changing call sites.
// ---------------------------------------------------------------------------
const INTENT_CACHE_TTL_MS = 3 * 60 * 1_000; // 3 minutes

interface CacheEntry {
  content: string | null;
  expiresAt: number;
}

const intentCache = new Map<string, CacheEntry>();

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
 * Results are cached in-memory for INTENT_CACHE_TTL_MS to avoid redundant
 * API calls on back-to-back pull_request events for the same repo.
 */
export async function fetchIntentFile(installationId: number, owner: string, repo: string) {
    const cacheKey = `${owner}/${repo}`;
    const now = Date.now();

    // Return cached result if still valid
    const cached = intentCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
        console.log(`[intentCache] HIT for ${cacheKey} (expires in ${Math.round((cached.expiresAt - now) / 1000)}s)`);
        return cached.content;
    }

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
          const content = Buffer.from(data.content, "base64").toString("utf-8");
          // Store successful fetch in cache
          intentCache.set(cacheKey, { content, expiresAt: now + INTENT_CACHE_TTL_MS });
          console.log(`[intentCache] MISS → fetched and cached for ${cacheKey}`);
          return content;
        }
      } catch (err) {
        // File not found at this path, continue to next
        continue;
      }
    }

    // No intent file found — cache the null result too so we don't keep
    // hammering the API for repos that don't have intent.md
    intentCache.set(cacheKey, { content: null, expiresAt: now + INTENT_CACHE_TTL_MS });
    console.log(`[intentCache] MISS → no intent.md found, cached null for ${cacheKey}`);
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
 *
 * @param externalId  Optional GitHub delivery ID. When provided, it is stored
 *                    as the check run's external_id so that hasCheckRunForDelivery
 *                    can detect an already-posted check run on BullMQ job retry,
 *                    preventing duplicates.
 */
export async function createCheckRun(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
  decision: 'APPROVE' | 'WARN' | 'BLOCK',
  summary: string,
  externalId?: string
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
    },
    ...(externalId ? { external_id: externalId } : {}),
  });
}

/**
 * hasCheckRunForDelivery
 * Returns true if a FeaturePulse Guard check run with the given external_id
 * (GitHub delivery ID) already exists for this SHA. Used by the worker to
 * skip re-posting the check run when a BullMQ job retries after a partial
 * completion.
 */
export async function hasCheckRunForDelivery(
  installationId: number,
  owner: string,
  repo: string,
  headSha: string,
  deliveryId: string
): Promise<boolean> {
  const octokit = await getClient(installationId);
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    check_name: 'FeaturePulse Guard',
    per_page: 50,
  });
  return data.check_runs.some(
    (run: { external_id?: string | null }) => run.external_id === deliveryId
  );
}

/**
 * featurePulseCommentFingerprint
 * Returns the hidden HTML comment string embedded in every FeaturePulse PR
 * comment. Used as a per-SHA fingerprint so findFeaturePulseComment can
 * detect an already-posted comment on retry without scanning comment bodies
 * for user-visible text (which could change across versions).
 */
export function featurePulseCommentFingerprint(headSha: string): string {
  return `<!-- featurepulse:${headSha} -->`;
}

/**
 * findFeaturePulseComment
 * Returns true if a FeaturePulse comment bearing the SHA fingerprint already
 * exists on the PR. Guards against duplicate comments when a job retries after
 * the comment was posted but before the job was marked complete.
 */
export async function findFeaturePulseComment(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<boolean> {
  const octokit = await getClient(installationId);
  const fingerprint = featurePulseCommentFingerprint(headSha);

  // List up to 100 comments — sufficient for the expected comment volume on
  // any single PR. If a PR somehow has > 100 comments we may miss the
  // fingerprint; acceptable edge case for a dev-focused tool.
  const { data } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  return data.some((comment: { body?: string }) =>
    comment.body?.includes(fingerprint)
  );
}

/**
 * configureBranchProtection
 * Configures branch protection on the repository's default branch to require
 * the 'FeaturePulse Guard' check run to pass before merging.
 */
export async function configureBranchProtection(installationId: number, owner: string, repo: string) {
    const octokit = await getClient(installationId);
    
    try {
        const { data: repoData } = await octokit.rest.repos.get({
            owner,
            repo
        });
        const defaultBranch = repoData.default_branch;
        await octokit.rest.repos.updateBranchProtection({
            owner,
            repo,
            branch: defaultBranch,
            required_status_checks: {
                strict: true,
                checks: [
                    {
                        context: 'FeaturePulse Guard',
                    }
                ]
            },
            enforce_admins: false,
            required_pull_request_reviews: null,
            restrictions: null,
        });
        console.log(`✅ Branch protection configured for ${owner}/${repo} on branch ${defaultBranch}`);
    } catch (err: any) {
        console.error(`❌ Failed to configure branch protection for ${owner}/${repo}:`, err.message);
    }
}