'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SelcomService } = require('../src/services/selcomService');
const { testConfig, signedCallback } = require('./helpers');
const { loadConfig } = require('../src/config');
const { amountCents } = require('../src/utils/validation');
const { queryOutcome } = require('../src/services/paymentService');

describe('Official client signing and bounded HTTP adapter', () => {
  it('uses the real installed export and signs the actual request fields in order', async () => {
    const config = testConfig(); let captured;
    const client = new SelcomService(config, { http: { request: async options => {
      captured = options; return { status: 200, data: '{"result":"PENDING","resultcode":"111","data":[]}' };
    } } });
    const reply = await client.initiateWalletPayment({ selcom_transid: 'abc', selcom_order_id: 'def', customer_phone: '255712345678' });
    assert.equal(captured.headers['Signed-Fields'], 'transid,order_id,msisdn');
    const string = `timestamp=${captured.headers.Timestamp}&transid=abc&order_id=def&msisdn=255712345678`;
    assert.equal(captured.headers.Digest, crypto.createHmac('sha256', config.selcomApiSecret).update(string).digest('base64'));
    assert.equal(captured.headers.Authorization, 'SELCOM ' + Buffer.from(config.selcomApiKey).toString('base64'));
    assert.equal(captured.signal.aborted, false);
    assert.equal(reply.data.resultcode, '111');
  });
  it('sends order-status parameters as a signed GET query', async () => {
    let captured;
    const client = new SelcomService(testConfig(), { http: { request: async options => { captured = options; return { status: 200, data: '{}' }; } } });
    await client.getOrderStatus({ selcom_order_id: 'an-order' });
    assert.equal(captured.method, 'GET');
    assert.deepEqual(captured.params, { order_id: 'an-order' });
    assert.equal(captured.headers['Signed-Fields'], 'order_id');
    assert.equal(captured.data, undefined);
  });
  it('preserves HTTP failures and handles network errors with no error.response', async () => {
    const config = testConfig();
    const network = new SelcomService(config, { http: { request: async () => { const error = new Error('sensitive arbitrary error'); error.code = 'ECONNRESET'; throw error; } } });
    const failed = await network.request('POST', '/path', { order_id: 'id' });
    assert.deepEqual(failed, { httpStatus: null, data: null, errorCode: 'ECONNRESET' });
    const http = new SelcomService(config, { http: { request: async () => ({ status: 403, data: '{"result":"FAIL"}' }) } });
    assert.equal((await http.request('GET', '/path', {})).httpStatus, 403);
  });
  it('rejects malformed provider JSON without exposing the raw body', async () => {
    const client = new SelcomService(testConfig(), { http: { request: async () => ({ status: 200, data: '<html>bad gateway</html>' }) } });
    assert.equal((await client.request('GET', '/path', {})).errorCode, 'INVALID_PROVIDER_JSON');
    assert.equal(client.http.defaults, undefined);
  });
  it('a genuine HTTP instance has a timeout, response-size bound and no redirects', () => {
    const client = new SelcomService(testConfig());
    assert.equal(client.http.defaults.timeout, 1000);
    assert.equal(client.http.defaults.maxRedirects, 0);
    assert.equal(client.http.defaults.maxContentLength, 65536);
  });
});

describe('Signature, amount and configuration boundaries', () => {
  it('checks callback digest, required signed fields and distinct valid/invalid dedupe namespaces', () => {
    const config = testConfig(); const now = Date.now();
    const client = new SelcomService(config, { clock: () => now });
    const signed = signedCallback({ selcom_order_id: 'order', selcom_transid: 'transaction' }, config, now);
    const headers = Object.fromEntries(Object.entries(signed.headers).map(([k,v]) => [k.toLowerCase(), v]));
    const valid = client.verifyWebhook(headers, signed.body);
    assert.equal(valid.valid, true);
    headers.digest = 'bad';
    const invalid = client.verifyWebhook(headers, signed.body);
    assert.equal(invalid.valid, false);
    assert.notEqual(invalid.dedupeKey, valid.dedupeKey);
  });
  it('compares monetary values exactly and rejects scientific notation or excess decimals', () => {
    assert.equal(amountCents('1000.00'), amountCents(1000));
    assert.equal(amountCents('0.01'), 1n);
    assert.equal(amountCents('1e3'), null);
    assert.equal(amountCents('1.001'), null);
    assert.equal(amountCents(null), null);
  });
  it('a status-query channel transid is not mistaken for the merchant transaction ID', () => {
    const outcome = queryOutcome({ httpStatus: 200, data: { result: 'SUCCESS', resultcode: '000', data: [{ order_id: 'order', amount: '1000.00', transid: 'NETWORK_ID', payment_status: 'COMPLETED' }] } }, { selcom_order_id: 'order', selcom_transid: 'MERCHANT_ID', amount: '1000.00', currency: 'TZS' });
    assert.equal(outcome.status, 'succeeded');
  });
  it('fails closed on missing credentials, unsafe URLs, and too-short reconciliation intervals', () => {
    const env = { NODE_ENV: 'test', DB_NAME: 'selcom_test', DB_USER: 'root', APP_API_KEY: 'a'.repeat(64), SELCOM_BASE_URL: 'https://selcom.test', SELCOM_API_KEY: 'k', SELCOM_API_SECRET: 's', SELCOM_VENDOR: 'v', PUBLIC_WEBHOOK_URL: 'https://merchant.test/hook' };
    assert.equal(loadConfig(env).selcomTimeoutMs, 20000);
    assert.throws(() => loadConfig({ ...env, SELCOM_API_SECRET: '' }), /SELCOM_API_SECRET/);
    assert.throws(() => loadConfig({ ...env, SELCOM_BASE_URL: 'http://selcom.test' }), /HTTPS/);
    assert.throws(() => loadConfig({ ...env, RECONCILE_INTERVAL_MS: '1000' }), /RECONCILE_INTERVAL_MS/);
    assert.throws(() => loadConfig({ ...env, APP_API_KEY: 'short' }), /APP_API_KEY/);
  });
});
