import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Railway
  },
  // Serverless-safe tuning: one connection per ephemeral function instance
  // prevents Railway hitting max_connections across concurrent Vercel invocations.
  max: 1,                      // 1 connection slot per function instance
  idleTimeoutMillis: 1000,     // release idle connections within 1s (before Railway RSTs them)
  connectionTimeoutMillis: 5000, // fail fast if the DB is unreachable rather than hanging
  allowExitOnIdle: true,       // let Node.js exit cleanly when the pool is empty (serverless teardown)
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};