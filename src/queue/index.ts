// src/queue/index.ts
// ---------------------------------------------------------------------------
// BullMQ queue definition and job type.
//
// Single queue "pr-analysis" for pull_request.opened / pull_request.synchronize
// events. The webhook handler enqueues here and returns 200 immediately;
// startWorker() (src/worker.ts) consumes jobs — runs in the same process as
// index.ts on Render's free tier, or as a standalone process when invoked via
// `npm run worker`.
//
// Job data carries everything the worker needs so it never has to re-read
// from the webhook payload after the job is created.
// ---------------------------------------------------------------------------

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

export interface PRAnalysisJobData {
  /** GitHub delivery ID from x-github-delivery header — used as external_id
   *  on the check run so retries can detect an already-posted check run. */
  deliveryId: string;

  /** The GitHub App installation ID (numeric, not the DB row ID). */
  githubInstallationId: number;

  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;

  /** ISO timestamp from pull_request.created_at — needed if we ever want to
   *  compute partial elapsed times in the worker, but mainly carried for
   *  auditability. */
  prCreatedAt: string;
}

// ---------------------------------------------------------------------------
// Shared ioredis connection.
// maxRetriesPerRequest=null is required by BullMQ — it disables ioredis's
// built-in per-request retry limit so BullMQ can manage reconnection itself.
// enableReadyCheck=false prevents ioredis from blocking on LOADING responses
// during Redis startup.
// ---------------------------------------------------------------------------
export function createRedisConnection() {
  let url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const isUpstash = url.includes('upstash.io');
  
  // ioredis strictly ignores the `tls` option if the URL starts with redis://
  // For Upstash, we MUST rewrite the scheme to rediss://
  if (isUpstash && url.startsWith('redis://')) {
    url = url.replace('redis://', 'rediss://');
  }
  
  const redis = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 10000,
    ...(isUpstash && { tls: { rejectUnauthorized: false } }),
    retryStrategy(times) {
      console.log(`[redis] Reconnecting (attempt ${times})...`);
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('connect', () => console.log(`[redis] Connected to ${isUpstash ? 'Upstash' : 'Redis'}.`));
  redis.on('ready', () => console.log(`[redis] Connection is READY.`));
  redis.on('error', (err) => console.error(`[redis] Connection error:`, err.message));

  return redis;
}

// ---------------------------------------------------------------------------
// Queue instance (used by the webhook handler to enqueue jobs).
// The connection here is separate from the worker's connection — BullMQ
// requires each Queue / Worker to own its own ioredis client.
// ---------------------------------------------------------------------------
export const prAnalysisQueue = new Queue<PRAnalysisJobData>('pr-analysis', {
  connection: createRedisConnection(),
  defaultJobOptions: {
    // Retry up to 3 times on failure with exponential backoff.
    // Attempt 1: immediate, Attempt 2: ~2s, Attempt 3: ~4s, Attempt 4: ~8s.
    attempts: 4,
    backoff: {
      type: 'exponential',
      delay: 2_000,
    },
    // Remove completed jobs after 24 h; keep failed jobs for 7 days for inspection.
    removeOnComplete: { age: 86_400 },
    removeOnFail: { age: 604_800 },
  },
});
