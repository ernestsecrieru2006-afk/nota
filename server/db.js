import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

// Single shared pool — used by server.js, auth.js, and iiko.js.
// Neon/Railway free tiers allow ~100 connections; max:10 leaves headroom.
export const pool = new Pool({
  connectionString:    process.env.DATABASE_URL,
  max:                 10,
  idleTimeoutMillis:   30_000,
  connectionTimeoutMillis: 5_000,
});
