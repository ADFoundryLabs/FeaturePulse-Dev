import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Create a connection pool (efficiently manages multiple connections)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Railway connections
  }
});

// Export a helper function to run queries
export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
};