const { Pool, types } = require('pg');
require('dotenv').config();

// The client expects plain 'YYYY-MM-DD' strings for DATE columns (that's
// what mockData.js seeds and what the screens format/compare against), not
// pg's default JS Date objects. OID 1082 = date.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Cloud Postgres providers (Neon, Render, etc.) require an encrypted
  // connection; a plain local Postgres via docker-compose doesn't need or
  // support this. Set DB_SSL=true in .env when DATABASE_URL points at a
  // hosted database. rejectUnauthorized: false is what these providers'
  // own connection docs recommend, since they use certs not in Node's
  // default trust store.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

module.exports = pool;
