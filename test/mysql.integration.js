'use strict';
const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/pool');
const { PaymentRepository } = require('../src/repositories/paymentRepository');
const { migrate } = require('../scripts/migrate');
const { testConfig, fixture } = require('./helpers');
const { workflowTests } = require('./workflows');

const database = process.env.TEST_DB_NAME;
if (!database || !/^[A-Za-z0-9_]+_test$/.test(database)) throw new Error('Set TEST_DB_NAME to a dedicated database ending in _test. These tests delete its payment/event rows.');
const dbConfig = loadConfig({
  NODE_ENV: 'test', DB_NAME: database, DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306', DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '', DB_CONNECTION_LIMIT: '25'
}, { databaseOnly: true });
const pool = createPool(dbConfig);
const initialized = migrate(pool, database);
async function makeFixture() {
  await initialized;
  await pool.query('DELETE FROM webhook_events');
  await pool.query('DELETE FROM payment_attempts');
  await pool.query('DELETE FROM payments');
  const config = testConfig();
  const time = { now: Date.now() };
  const repo = new PaymentRepository(pool, config, () => time.now);
  return fixture({ config, time, repository: repo });
}
after(async () => { await pool.end(); });

workflowTests('Payment API with real SQL transactions and mocked Selcom', makeFixture);
describe('SQL migration and audit invariants', () => {
  it('can rerun the unchanged migration without losing records', async () => {
    const f = await makeFixture();
    const result = await f.service.initiate(f.input, 'audit-key');
    assert.equal(await migrate(pool, database), 0);
    assert.ok(await f.repo.getByPaymentId(result.payment.payment_id));
  });
  it('stores audit payloads without phone, email, name, or credentials', async () => {
    const f = await makeFixture();
    await f.service.initiate(f.input, 'audit-key');
    const [rows] = await pool.query('SELECT request_payload FROM payment_attempts');
    const stored = JSON.stringify(rows);
    assert.ok(!stored.includes(f.input.customerEmail));
    assert.ok(!stored.includes('255712345678'));
    assert.ok(!stored.includes(f.input.customerName));
    assert.ok(!stored.includes(f.config.selcomApiSecret));
  });
  it('expired status-query leases can be recovered without initiating a new payment', async () => {
    const f = await makeFixture();
    const result = await f.service.initiate(f.input, 'lease-key');
    f.time.now += 180001;
    const claimed = await f.repo.claimCheck({ id: result.payment.id });
    assert.ok(claimed);
    assert.equal(await f.service.reconcileBatch(), 0);
    f.time.now += f.config.selcomTimeoutMs + 30001;
    f.selcom.status = 'COMPLETED';
    assert.equal(await f.service.reconcileBatch(), 1);
    assert.equal((await f.repo.getById(result.payment.id)).status, 'succeeded');
    assert.equal(f.selcom.calls.wallet, 1);
  });
  it('a crash on the final automatic check leaves the payment visibly marked for manual review', async () => {
    const f = await makeFixture();
    f.config.reconcileMaxAttempts = 1;
    const result = await f.service.initiate(f.input, 'last-lease-key');
    f.time.now += 180001;
    const claim = await f.repo.claimCheck({ id: result.payment.id });
    assert.ok(claim);
    f.time.now += f.config.selcomTimeoutMs + 30001;
    assert.equal(await f.service.reconcileBatch(), 0);
    const row = await f.repo.getById(result.payment.id);
    assert.equal(Boolean(row.manual_review), true);
    assert.equal(row.next_check_at, null);
  });
  it('database sessions use UTC independently of the server default timezone', async () => {
    await initialized;
    const [rows] = await pool.query('SELECT @@session.time_zone AS tz');
    assert.equal(rows[0].tz, '+00:00');
  });
  it('starts the real server, serves authenticated reads, and shuts down gracefully without provider calls', async () => {
    await initialized;
    const port = 41000 + Math.floor(Math.random() * 1000);
    const appKey = 'b'.repeat(64);
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_API_KEY: appKey,
        DB_NAME: database, DB_HOST: dbConfig.db.host, DB_PORT: String(dbConfig.db.port), DB_USER: dbConfig.db.user, DB_PASSWORD: dbConfig.db.password,
        SELCOM_BASE_URL: 'https://selcom.test', SELCOM_API_KEY: 'test-only-key', SELCOM_API_SECRET: 'test-only-secret',
        SELCOM_VENDOR: 'TESTONLY', PUBLIC_WEBHOOK_URL: 'https://merchant.test/api/v1/webhooks/selcom', RECONCILE_ENABLED: 'false' }
    });
    let logs = '';
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Server failed to become ready: ' + logs)), 10000);
        child.stdout.on('data', chunk => { logs += chunk; if (logs.includes('server_started')) resolve(); });
        child.stderr.on('data', chunk => { logs += chunk; });
        child.once('error', reject);
        child.once('exit', code => reject(new Error('Server exited before listening: ' + code + ' ' + logs)));
      });
      clearTimeout(timer);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.deepEqual(await health.json(), { status: 'ok' });
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/payments`)).status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/payments`, { headers: { 'X-API-Key': appKey } })).status, 200);
      child.kill('SIGTERM');
      assert.equal(await closed, 0);
      assert.ok(!logs.includes(appKey));
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await closed; } }
  });
});
