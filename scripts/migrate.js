'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPool } = require('../src/db/pool');
const { loadConfig } = require('../src/config');

async function migrate(pool, databaseName) {
  const connection = await pool.getConnection();
  const lock = 'selcom_migrate_' + createHash('sha256').update(databaseName).digest('hex').slice(0, 32);
  let locked = false;
  try {
    const [rows] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(rows[0].acquired) !== 1) throw new Error('Another migration is running. Retry later.');
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(200) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const folder = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(folder)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    let applied = 0;
    for (const name of files) {
      const sql = await fs.readFile(path.join(folder, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [previous] = await connection.execute('SELECT checksum FROM schema_migrations WHERE name=?', [name]);
      if (previous[0]) {
        if (previous[0].checksum !== checksum) throw new Error(`Migration ${name} changed after being applied. Add a new migration instead.`);
        continue;
      }
      // Migrations are trusted files shipped with this project; no user SQL is accepted.
      for (const statement of sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations (name,checksum) VALUES (?,?)', [name, checksum]);
      applied++;
    }
    return applied;
  } finally {
    if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lock]);
    connection.release();
  }
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  (async () => {
    const config = loadConfig(process.env, { databaseOnly: true });
    const pool = createPool(config);
    try { console.info(JSON.stringify({ event: 'migrations_complete', applied: await migrate(pool, config.db.database) })); }
    finally { await pool.end(); }
  })().catch(error => { console.error(JSON.stringify({ event: 'migration_failed', code: error.code || 'MIGRATION_ERROR', message: error.code ? 'Check database credentials, privileges, and connectivity.' : error.message })); process.exitCode = 1; });
}

module.exports = { migrate };
