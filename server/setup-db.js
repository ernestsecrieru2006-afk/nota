// setup-db.js — run this once to create all the tables in your database.
// Usage: node server/setup-db.js

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const { Pool } = pg;

// Find the schema.sql file next to this script.
const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query(schema);
  console.log('✓ Schema loaded — all tables created.');
} catch (err) {
  console.error('❌  Failed to load schema:', err.message);
} finally {
  await pool.end();
}
