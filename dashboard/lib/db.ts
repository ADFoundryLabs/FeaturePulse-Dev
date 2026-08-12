import { Pool } from '@neondatabase/serverless';

// Neon serverless driver: uses WebSocket transport instead of raw TCP.
// This eliminates the ECONNRESET failures that occur on Vercel when idle
// TCP connections are RST between serverless invocations.
//
// ENDPOINT: uses the POOLED connection string (DATABASE_URL_POOLED), not the
// direct one. Reason: Vercel may spin up many concurrent function instances,
// each instantiating this Pool. The pooled endpoint (-pooler suffix) fronts
// Neon compute with PgBouncer, which multiplexes those connections down to a
// manageable number. Without it, concurrent invocations could exhaust Neon's
// direct connection limit (10 on the free tier).
//
// @neondatabase/serverless's Pool is explicitly designed to work through
// PgBouncer — it does not use named prepared statements that PgBouncer's
// transaction mode would drop. This is safe.
//
// The Pool shim exposes the same .query(text, params?) → QueryResult interface
// as pg.Pool, so callers (page.tsx etc.) need no changes.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_POOLED,
  // No ssl option needed: Neon requires TLS and ?sslmode=require in the URL
  // handles it. Neon uses a valid CA-signed certificate — rejectUnauthorized:false
  // is not needed (and would be a security regression).
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};