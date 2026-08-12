import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Long-lived Express process on Railway: plain pg.Pool is appropriate here.
// This is NOT serverless — app.listen() runs indefinitely, so the HTTP driver
// overhead of @neondatabase/serverless would be wasteful.
//
// ssl: true (instead of the old rejectUnauthorized: false): Neon provides a
// valid CA-signed certificate, so we no longer need to disable cert validation.
// The old flag was a Railway-specific workaround for their self-signed cert.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
});

// Export a helper function to run queries
export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};