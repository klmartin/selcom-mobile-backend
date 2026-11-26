'use strict';
require('dotenv').config({ quiet: true });
const { loadConfig } = require('../src/config');
const { bootstrap } = require('../src/bootstrap');

(async () => {
  const { pool, service } = bootstrap(loadConfig());
  try { console.info(JSON.stringify({ event: 'reconciliation_complete', checked: await service.reconcileBatch() })); }
  finally { await pool.end(); }
})().catch(error => { console.error(JSON.stringify({ event: 'reconciliation_failed', code: error.code || 'CONFIG_ERROR', message: error.code ? 'Check database connectivity.' : error.message })); process.exitCode = 1; });
