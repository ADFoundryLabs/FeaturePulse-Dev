import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Railway
  }
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};