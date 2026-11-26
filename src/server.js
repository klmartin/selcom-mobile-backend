'use strict';
require('dotenv').config({ quiet: true });
const { loadConfig } = require('./config');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const { startWorker } = require('./services/reconcileWorker');
const { deliverCallback } = require('./services/callbackDelivery');

async function main() {
  const config = loadConfig();
  const { pool, service, repository } = bootstrap(config);
  try {
    await pool.query('SELECT callback_url FROM payments LIMIT 0');
    await pool.query('SELECT id FROM payment_attempts LIMIT 0');
    await pool.query('SELECT delivery_due_at FROM webhook_events LIMIT 0');
  } catch (error) { await pool.end(); throw error; }
  const app = createApp({ service, config });
  const server = app.listen(config.port, config.host, () => {
    console.info(JSON.stringify({ event: 'server_started', host: config.host, port: config.port, reconciliation: config.reconcileEnabled }));
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  const workers = [];
  if (config.reconcileEnabled) {
    workers.push(startWorker(options => service.reconcileBatch(options), config.reconcilePollMs, 'reconciliation_error'));
  }
  workers.push(startWorker(() => deliverCallback(repository), 1000, 'callback_delivery_error'));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: 'server_stopping' }));
    const deadline = setTimeout(() => process.exit(1), 60000);
    deadline.unref();
    const closed = new Promise(resolve => server.close(resolve));
    await Promise.all(workers.map(worker => worker.stop()));
    await closed;
    await pool.end();
    clearTimeout(deadline);
  };
  server.on('error', error => {
    console.error(JSON.stringify({ event: 'listen_error', code: error.code || 'LISTEN_ERROR' }));
    shutdown().catch(() => process.exit(1));
    process.exitCode = 1;
  });
  process.once('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.once('SIGINT', () => shutdown().catch(() => process.exit(1)));
}

main().catch(error => {
  const configError = !error.code;
  console.error(JSON.stringify({ event: 'startup_failed', code: error.code || 'CONFIG_ERROR', message: configError ? error.message : 'Check database connectivity and run npm run migrate. No provider request was sent.' }));
  process.exitCode = 1;
});
