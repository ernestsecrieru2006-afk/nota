// db.js — sets up the connection to PostgreSQL.
// Every other file imports `pool` from here and uses pool.query() to talk to the database.

import pg from 'pg';

const { Pool } = pg;

// DATABASE_URL is a single string that contains everything Postgres needs:
// the host, port, username, password, and database name.
// Example: postgres://user:password@localhost:5432/nota
//
// Railway and Neon set this automatically when you add a Postgres instance.
// For local development, you set it yourself in a .env file (see README).
if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set. See README.md for setup instructions.');
  process.exit(1); // stop the server — there's no point running without a database
}

// "Pool" keeps a set of database connections open so we don't reconnect on every request.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  // Cloud databases (Railway, Neon) require an encrypted SSL connection.
  // Local Postgres doesn't — so we skip SSL when the URL points to localhost.
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

// Test the connection once on startup so we fail fast if something is wrong.
pool.query('SELECT 1').then(() => {
  console.log('✓ Database connected');
}).catch((err) => {
  console.error('❌  Could not connect to database:', err.message);
  process.exit(1);
});

export default pool;
