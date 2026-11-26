'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const request = require('supertest');
const { deliverCallback } = require('../src/services/callbackDelivery');
const { fixture, signedCallback } = require('./helpers');

it('queues only verified callbacks for the caller URL and signs a retryable notification', async () => {
  const f = fixture();
  f.config.callbackOrigins = ['https://merchant.test'];
  f.config.callbackSigningSecret = 'secret-for-the-merchant-endpoint';
  const callbackUrl = 'https://merchant.test/payment-callback';
  const create = url => request(f.app).post('/api/v1/payments/mobile')
    .set('X-API-Key', f.config.appApiKey).set('Idempotency-Key', 'callback-test')
    .send({ ...f.input, callbackUrl: url });
  await create('https://other.test/hook').expect(400);
  const response = await create(callbackUrl).expect(202);
  await create(`${callbackUrl}/different`).expect(409);
  assert.equal(f.selcom.lastOrder.webhook, Buffer.from(f.config.publicWebhookUrl).toString('base64'));
  const payment = await f.repo.getByPaymentId(response.body.data.paymentId);
  const signed = signedCallback(payment, f.config, f.time.now);
  const receive = headers => request(f.app).post('/api/v1/webhooks/selcom').set(headers).send(signed.body);
  await receive({ ...signed.headers, Digest: 'invalid' }).expect(401);
  await receive(signed.headers).expect(200);
  await receive(signed.headers).expect(200);
  const queued = [...f.repo.events.values()].filter(event => event.forward);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].verified, true);

  const outcomes = [];
  const event = { payment_id: payment.id, dedupe_key: queued[0].key, payload: JSON.stringify(queued[0].payload), delivery_attempts: 1 };
  const repository = {
    claimDelivery: async () => event,
    getById: id => f.repo.getById(id),
    completeDelivery: async (_, result) => outcomes.push(result)
  };
  const bodies = [];
  const http = { post: async (url, body, options) => {
    assert.equal(url, callbackUrl);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.headers['X-Callback-Signature'], 'sha256=' + createHmac('sha256', f.config.callbackSigningSecret).update(body).digest('hex'));
    const notification = JSON.parse(body);
    assert.equal(notification.eventId, event.dedupe_key);
    assert.equal(notification.paymentId, payment.payment_id);
    assert.equal(notification.callback.payment_status, 'COMPLETED');
    assert.equal(notification.callback.amount, undefined);
    bodies.push(body);
    return { status: bodies.length === 1 ? 503 : 204 };
  } };
  await deliverCallback(repository, f.config, http);
  event.delivery_attempts++;
  await deliverCallback(repository, f.config, http);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(outcomes, [
    { status: 503, delivered: false, retryDelay: 15000 },
    { status: 204, delivered: true, retryDelay: null }
  ]);
});
