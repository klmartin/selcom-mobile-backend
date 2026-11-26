'use strict';
const { SelcomService } = require('../src/services/selcomService');
const { PaymentService } = require('../src/services/paymentService');
const { createApp } = require('../src/app');
const { AppError } = require('../src/utils/errors');
const { CALLBACK_FIELDS } = require('../src/services/selcomService');
const { createHmac } = require('node:crypto');

function testConfig() {
  return {
    nodeEnv: 'test', appApiKey: 'a'.repeat(64), trustProxyHops: 0,
    selcomBaseUrl: 'https://selcom.test', selcomApiKey: 'test-key', selcomApiSecret: 'test-secret',
    selcomVendor: 'TESTVENDOR', publicWebhookUrl: 'https://merchant.test/api/v1/webhooks/selcom',
    selcomTimeoutMs: 1000, paymentMin: 100, paymentMax: 10000000,
    reconcileInitialDelayMs: 180000, reconcileIntervalMs: 180000,
    reconcileMaxAttempts: 3, reconcileBatchSize: 10, webhookMaxSkewSeconds: 300,
    rateLimitWindowMs: 60000, rateLimitMax: 10000, webhookRateLimitMax: 10000, jsonBodyLimit: '64kb'
  };
}

const clone = value => structuredClone(value);
class MemoryRepository {
  constructor(config, clock) { this.config = config; this.clock = clock; this.rows = []; this.attempts = []; this.events = new Map(); }
  async getById(id) { return clone(this.rows.find(p => p.id === id) || null); }
  async getByPaymentId(id) { return clone(this.rows.find(p => p.payment_id === id) || null); }
  async getByOrderId(id) { return clone(this.rows.find(p => p.selcom_order_id === id) || null); }
  async createOrGet(record) {
    const old = this.rows.find(p => p.idempotency_key === record.idempotency_key);
    if (old) {
      if (old.request_hash !== record.request_hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Different payment details.');
      return { payment: clone(old), created: false };
    }
    if (this.rows.some(p => p.merchant_reference === record.merchant_reference)) throw new AppError(409, 'REFERENCE_CONFLICT', 'Reference already exists.');
    const row = { ...record, id: this.rows.length + 1, status: 'pending', initiation_stage: 'recorded',
      provider_payment_status: null, provider_reference: null, provider_result_code: null, provider_message: null,
      created_at: new Date(this.clock()), updated_at: new Date(this.clock()), paid_at: null,
      manual_review: false, next_check_at: null, last_checked_at: null, reconciliation_attempts: 0,
      reconcile_token: null, reconcile_until: null };
    this.rows.push(row);
    return { payment: clone(row), created: true };
  }
  async claimDispatch(id, expected, next) {
    const row = this.rows.find(p => p.id === id);
    if (!row || row.initiation_stage !== expected || !['pending','unresolved','awaiting_authorization'].includes(row.status)) return false;
    row.initiation_stage = next;
    row.next_check_at ??= new Date(this.clock() + this.config.reconcileInitialDelayMs);
    return true;
  }
  async applyProgress(id, changes) {
    const row = this.rows.find(p => p.id === id);
    if (!['pending','unresolved','awaiting_authorization'].includes(row.status)) return;
    Object.assign(row, changes);
    row.updated_at = new Date(this.clock());
    if (['failed','cancelled'].includes(row.status)) row.next_check_at = null;
    else row.next_check_at ??= new Date(this.clock() + this.config.reconcileIntervalMs);
  }
  async startAttempt(paymentId, operation, request) { this.attempts.push({ id: this.attempts.length + 1, paymentId, operation, request }); return this.attempts.length; }
  async finishAttempt(id, reply) { this.attempts[id - 1].reply = reply; }
  async list({ page, pageSize, status }) {
    const rows = this.rows.filter(p => !status || p.status === status);
    return { rows: clone(rows.slice((page - 1) * pageSize, page * pageSize)), total: rows.length };
  }
  async claimCheck({ id = null, allowEarly = false, manual = false } = {}) {
    const row = this.rows.find(p => (id === null || p.id === id) && p.status !== 'succeeded' && p.initiation_stage !== 'recorded' &&
      (!p.reconcile_until || +new Date(p.reconcile_until) <= this.clock()) &&
      (manual || (['pending','awaiting_authorization','unresolved'].includes(p.status) && p.reconciliation_attempts < this.config.reconcileMaxAttempts)) &&
      (allowEarly || (p.next_check_at && +new Date(p.next_check_at) <= this.clock()) ||
       (manual && !p.next_check_at && (!p.last_checked_at || +new Date(p.last_checked_at) <= this.clock() - this.config.reconcileIntervalMs))));
    if (!row) return null;
    row.reconcile_token = String(Math.random()); row.reconcile_until = new Date(this.clock() + this.config.selcomTimeoutMs + 30000);
    row.last_checked_at = new Date(this.clock()); row.reconciliation_attempts++;
    if (row.reconciliation_attempts >= this.config.reconcileMaxAttempts) { row.manual_review = true; row.next_check_at = null; }
    return clone(row);
  }
  async completeCheck(payment, outcome) {
    const row = this.rows.find(p => p.id === payment.id);
    if (row.reconcile_token !== payment.reconcile_token) return;
    if (row.status !== 'succeeded') {
      row.status = outcome.status; row.provider_payment_status = outcome.providerStatus || null;
      row.provider_reference = outcome.reference || row.provider_reference; row.provider_result_code = outcome.code;
      row.provider_message = outcome.message;
      const terminal = ['succeeded','failed','cancelled'].includes(row.status);
      row.manual_review = !terminal && row.reconciliation_attempts >= this.config.reconcileMaxAttempts;
      row.next_check_at = terminal || row.manual_review ? null : new Date(this.clock() + this.config.reconcileIntervalMs);
      if (row.status === 'succeeded') row.paid_at ??= new Date(this.clock());
    }
    row.reconcile_token = null; row.reconcile_until = null;
    if (row.status === 'succeeded') for (const event of this.events.values()) if (event.paymentId === row.id) event.processing_status = 'verified';
  }
  async storeWebhook(event) {
    if (this.events.has(event.key)) return { created: false };
    this.events.set(event.key, { ...clone(event), processing_status: event.verified ? 'queued' : 'rejected' });
    if (event.verified && event.paymentId !== null) {
      const row = this.rows.find(p => p.id === event.paymentId);
      if (row.status === 'succeeded') this.events.get(event.key).processing_status = 'verified';
      else {
        row.next_check_at = new Date(this.clock()); row.manual_review = false;
        if (['failed','cancelled'].includes(row.status)) row.status = 'unresolved';
        row.reconciliation_attempts = Math.min(row.reconciliation_attempts, this.config.reconcileMaxAttempts - 1);
      }
    }
    return { created: true };
  }
}

class FakeSelcom extends SelcomService {
  constructor(config, clock) {
    super(config, { clock, http: { request: () => { throw new Error('Unexpected real HTTP request.'); } } });
    this.calls = { create: 0, wallet: 0, status: 0 };
    this.status = 'PENDING';
  }
  async createCheckoutOrder(payment) {
    this.calls.create++; this.lastOrder = this.orderPayload(payment);
    return this.onCreate ? this.onCreate(payment) : { httpStatus: 200, data: { result: 'SUCCESS', resultcode: '000', data: [{ payment_token: 'TEST' }] } };
  }
  async initiateWalletPayment(payment) {
    this.calls.wallet++; this.lastWallet = this.walletPayload(payment);
    return this.onWallet ? this.onWallet(payment) : { httpStatus: 200, data: { result: 'PENDING', resultcode: '111', reference: 'GATEWAY1', data: [] } };
  }
  async getOrderStatus(payment) {
    this.calls.status++;
    return this.onStatus ? this.onStatus(payment) : { httpStatus: 200, data: { result: 'SUCCESS', resultcode: '000', data: [{
      order_id: payment.selcom_order_id, amount: payment.amount, payment_status: this.status,
      transid: 'CHANNEL_ID_DIFFERENT_FROM_MERCHANT', reference: 'GATEWAY1'
    }] } };
  }
}

function signedCallback(payment, config, now = Date.now(), changes = {}) {
  const body = { transid: payment.selcom_transid, order_id: payment.selcom_order_id, reference: 'GATEWAY1',
    result: 'SUCCESS', resultcode: '000', payment_status: 'COMPLETED', amount: '1000', ...changes };
  const timestamp = new Date(now).toISOString();
  const string = 'timestamp=' + timestamp + CALLBACK_FIELDS.map(f => '&' + f + '=' + body[f]).join('');
  return { body, headers: { Authorization: 'SELCOM ' + Buffer.from(config.selcomApiKey).toString('base64'), Timestamp: timestamp,
    'Digest-Method': 'HS256', 'Signed-Fields': CALLBACK_FIELDS.join(','), Digest: createHmac('sha256', config.selcomApiSecret).update(string).digest('base64') } };
}

function fixture({ config = testConfig(), repository = null, time = { now: Date.now() } } = {}) {
  const clock = () => time.now;
  const repo = repository || new MemoryRepository(config, clock);
  const selcom = new FakeSelcom(config, clock);
  const service = new PaymentService(repo, selcom, config, clock);
  const app = createApp({ service, config, logger: { info() {}, error() {} } });
  const input = { merchantReference: 'ORDER-1001', phone: '0712345678', amount: 1000, currency: 'TZS', customerName: 'Test Customer', customerEmail: 'customer@example.com', description: 'Test order' };
  return { config, repo, selcom, service, app, input, time, async close() {} };
}

module.exports = { testConfig, MemoryRepository, FakeSelcom, fixture, signedCallback };
