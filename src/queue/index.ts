// src/queue/index.ts
// ---------------------------------------------------------------------------
// Phase 4: BullMQ queue definition and job type.
//
// Single queue "pr-analysis" for pull_request.opened / pull_request.synchronize
// events. The webhook handler enqueues here and returns 200 immediately;
// the worker (src/worker.ts) consumes jobs in a separate process.
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
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
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
