'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { signedCallback } = require('./helpers');

function workflowTests(name, makeFixture) {
  describe(name, () => {
    let f;
    beforeEach(async () => { f = await makeFixture(); });
    afterEach(async () => { await f.close(); });
    const post = (changes = {}, key = 'idem-1') => request(f.app).post('/api/v1/payments/mobile').set('X-API-Key', f.config.appApiKey).set('Idempotency-Key', key).send({ ...f.input, ...changes });
    const callback = signed => request(f.app).post('/api/v1/webhooks/selcom').set(signed.headers).send(signed.body);

    it('requires authentication and validates input without contacting Selcom', async () => {
      await request(f.app).post('/api/v1/payments/mobile').send(f.input).expect(401);
      await post({ amount: -1 }).expect(400);
      await post({ phone: 'not-a-phone' }).expect(400);
      await post({ customerEmail: '' }).expect(400);
      await request(f.app).post('/api/v1/payments/mobile').set('X-API-Key', f.config.appApiKey).send(f.input).expect(400);
      assert.equal(f.selcom.calls.create, 0);
    });

    it('creates an order and one prompt with normalized phone and a Base64 webhook', async () => {
      const response = await post().expect(202);
      assert.equal(response.body.data.status, 'awaiting_authorization');
      assert.equal(response.body.data.phone, '255712345678');
      assert.equal(f.selcom.lastOrder.amount, 1000);
      assert.equal(f.selcom.lastOrder.buyer_name, f.input.customerName);
      assert.equal(Buffer.from(f.selcom.lastOrder.webhook, 'base64').toString(), f.config.publicWebhookUrl);
      assert.deepEqual(f.selcom.calls, { create: 1, wallet: 1, status: 0 });
      const detail = await request(f.app).get('/api/v1/payments/' + response.body.data.paymentId).set('X-API-Key', f.config.appApiKey).expect(200);
      assert.equal(detail.body.data.amount, '1000.00');
    });

    it('replays the same normalized payment and rejects changed details or reference reuse', async () => {
      const original = await post().expect(202);
      const replay = await post({ phone: '+255712345678' }).expect(202);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.data.paymentId, original.body.data.paymentId);
      await post({ amount: 2000 }).expect(409);
      await post({}, 'different-key').expect(409);
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('twenty concurrent identical requests dispatch exactly one order and one prompt', async () => {
      const responses = await Promise.all(Array.from({ length: 20 }, () => post()));
      assert.ok(responses.every(r => r.status === 202));
      assert.equal(new Set(responses.map(r => r.body.data.paymentId)).size, 1);
      assert.equal(f.selcom.calls.create, 1);
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('does not send a prompt after an order-create timeout, including on retry', async () => {
      f.selcom.onCreate = async () => ({ errorCode: 'ETIMEDOUT', data: null, httpStatus: null });
      const original = await post().expect(202);
      assert.equal(original.body.data.status, 'unresolved');
      await post().expect(202);
      assert.equal(f.selcom.calls.create, 1);
      assert.equal(f.selcom.calls.wallet, 0);
      f.time.now += 180001;
      await f.service.reconcileBatch();
      assert.equal(f.selcom.calls.wallet, 0);
    });

    it('reconciles a wallet timeout without sending another prompt', async () => {
      f.selcom.onWallet = async () => ({ errorCode: 'ETIMEDOUT', data: null, httpStatus: null });
      const original = await post().expect(202);
      await post().expect(202);
      assert.equal(f.selcom.calls.wallet, 1);
      f.selcom.status = 'COMPLETED'; f.time.now += 180001;
      await f.service.reconcileBatch();
      const payment = await f.service.getPayment(original.body.data.paymentId);
      assert.equal(payment.status, 'succeeded');
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('persists and deduplicates signed callbacks, then verifies status and amount independently', async () => {
      const original = await post().expect(202);
      let payment = await f.service.getPayment(original.body.data.paymentId);
      const signed = signedCallback(payment, f.config, f.time.now, { amount: '99999999', phone: 'unsigned' });
      await callback(signed).expect(200);
      assert.notEqual((await f.service.getPayment(payment.payment_id)).status, 'succeeded');
      f.selcom.status = 'COMPLETED';
      await f.service.reconcileBatch();
      payment = await f.service.getPayment(payment.payment_id);
      assert.equal(payment.status, 'succeeded');
      assert.ok(payment.paid_at);
      assert.equal(f.selcom.calls.status, 1);
      // A delivery with a fresh timestamp is still the same provider event.
      await callback(signedCallback(payment, f.config, f.time.now + 1000)).expect(200);
      await f.service.reconcileBatch();
      assert.equal(f.selcom.calls.status, 1);
    });

    it('rejects tampered signatures, missing signed fields, stale timestamps, and wrong identities', async () => {
      const original = await post().expect(202);
      const payment = await f.service.getPayment(original.body.data.paymentId);
      const tampered = signedCallback(payment, f.config, f.time.now);
      tampered.body.payment_status = 'PENDING';
      await callback(tampered).expect(401);
      const missing = signedCallback(payment, f.config, f.time.now);
      missing.headers['Signed-Fields'] = 'reference,result,resultcode,payment_status';
      await callback(missing).expect(401);
      await callback(signedCallback(payment, f.config, f.time.now - 3600000)).expect(401);
      await callback(signedCallback(payment, f.config, f.time.now, { transid: 'WRONG' })).expect(400);
      assert.equal(await f.service.reconcileBatch(), 0);
      assert.notEqual((await f.service.getPayment(payment.payment_id)).status, 'succeeded');
    });

    it('twenty simultaneous callback deliveries are durably deduplicated without duplicate status calls', async () => {
      const result = await post().expect(202);
      const payment = await f.service.getPayment(result.body.data.paymentId);
      const signed = signedCallback(payment, f.config, f.time.now);
      const replies = await Promise.all(Array.from({ length: 20 }, () => callback(signed)));
      assert.ok(replies.every(r => r.status === 200));
      f.selcom.status = 'COMPLETED';
      assert.equal(await f.service.reconcileBatch(), 1);
      assert.equal(f.selcom.calls.status, 1);
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('handles an early callback and never overwrites paid with a stale initiation error', async () => {
      f.selcom.onWallet = async payment => {
        f.selcom.status = 'COMPLETED';
        const signed = signedCallback(payment, f.config, f.time.now);
        await callback(signed).expect(200);
        await f.service.reconcileBatch();
        return { httpStatus: null, errorCode: 'ETIMEDOUT', data: null };
      };
      const response = await post().expect(200);
      assert.equal(response.body.data.status, 'succeeded');
      await f.repo.applyProgress((await f.service.getPayment(response.body.data.paymentId)).id, { status: 'unresolved' });
      assert.equal((await f.service.getPayment(response.body.data.paymentId)).status, 'succeeded');
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('does not accept order creation or unsigned callback status as payment success', async () => {
      const result = await post().expect(202);
      const payment = await f.service.getPayment(result.body.data.paymentId);
      await request(f.app).post('/api/v1/webhooks/selcom').send({ order_id: payment.selcom_order_id, payment_status: 'COMPLETED' }).expect(401);
      assert.equal((await f.service.getPayment(payment.payment_id)).status, 'awaiting_authorization');
    });

    it('keeps mismatched provider amounts unresolved and stops automatic checks at the retry limit', async () => {
      const result = await post().expect(202);
      f.selcom.onStatus = async p => ({ httpStatus: 200, data: { result: 'SUCCESS', resultcode: '000', data: [{ order_id: p.selcom_order_id, amount: '9999', payment_status: 'COMPLETED' }] } });
      for (let i = 0; i < f.config.reconcileMaxAttempts; i++) { f.time.now += 180001; await f.service.reconcileBatch(); }
      const payment = await f.service.getPayment(result.body.data.paymentId);
      assert.equal(payment.status, 'unresolved');
      assert.equal(Boolean(payment.manual_review), true);
      assert.equal(payment.next_check_at, null);
      f.time.now += 180001;
      assert.equal(await f.service.reconcileBatch(), 0);
    });

    it('concurrent workers claim a due payment once and never resend collections', async () => {
      await post().expect(202); f.time.now += 180001;
      const counts = await Promise.all([f.service.reconcileBatch(), f.service.reconcileBatch()]);
      assert.equal(counts.reduce((a, b) => a + b, 0), 1);
      assert.equal(f.selcom.calls.status, 1);
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('manual refresh respects the provider query interval and only runs status queries', async () => {
      const result = await post().expect(202);
      const url = '/api/v1/payments/' + result.body.data.paymentId + '/refresh';
      await request(f.app).post(url).set('X-API-Key', f.config.appApiKey).expect(200);
      assert.equal(f.selcom.calls.status, 0);
      f.time.now += 180001;
      await request(f.app).post(url).set('X-API-Key', f.config.appApiKey).expect(200);
      assert.equal(f.selcom.calls.status, 1);
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('a later signed callback reopens a rejected payment for status verification only', async () => {
      f.selcom.onWallet = async () => ({ httpStatus: 200, data: { result: 'FAIL', resultcode: '400', data: [] } });
      const result = await post().expect(200);
      assert.equal(result.body.data.status, 'failed');
      const payment = await f.service.getPayment(result.body.data.paymentId);
      f.selcom.status = 'COMPLETED';
      await callback(signedCallback(payment, f.config, f.time.now)).expect(200);
      assert.equal(await f.service.reconcileBatch(), 1);
      assert.equal((await f.service.getPayment(payment.payment_id)).status, 'succeeded');
      assert.equal(f.selcom.calls.wallet, 1);
    });

    it('lists payments with bounded pagination and no provider calls', async () => {
      await post().expect(202);
      const list = await request(f.app).get('/api/v1/payments?page=1&pageSize=1&status=awaiting_authorization').set('X-API-Key', f.config.appApiKey).expect(200);
      assert.equal(list.body.pagination.total, 1);
      await request(f.app).get('/api/v1/payments?pageSize=1000').set('X-API-Key', f.config.appApiKey).expect(400);
      assert.equal(f.selcom.calls.status, 0);
    });
  });
}

module.exports = { workflowTests };
