'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { deliverCallback } = require('../src/services/callbackDelivery');
const { parseCallbackUrl, publicLookup } = require('../src/utils/callbackUrl');
const { fixture, signedCallback } = require('./helpers');

it('queues only verified callbacks and forwards an unsigned notification to an unconfigured public URL', async () => {
  const f = fixture();
  const callbackUrl = 'https://merchant.test/payment-callback';
  const create = url => request(f.app).post('/api/v1/payments/mobile')
    .set('X-API-Key', f.config.appApiKey).set('Idempotency-Key', 'callback-test')
    .send({ ...f.input, callbackUrl: url });
  await create('https://127.0.0.1/hook').expect(400);
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
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
    assert.equal(options.proxy, false);
    const notification = JSON.parse(body);
    assert.equal(notification.eventId, event.dedupe_key);
    assert.equal(notification.paymentId, payment.payment_id);
    assert.equal(notification.callback.payment_status, 'COMPLETED');
    assert.equal(notification.callback.amount, undefined);
    bodies.push(body);
    return { status: bodies.length === 1 ? 503 : 204 };
  } };
  await deliverCallback(repository, http);
  event.delivery_attempts++;
  await deliverCallback(repository, http);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(outcomes, [
    { status: 503, delivered: false, retryDelay: 15000 },
    { status: 204, delivered: true, retryDelay: null }
  ]);
});

it('blocks private IP literals and passes only public DNS answers to the HTTPS socket', async () => {
  for (const host of ['127.1', '0xa9fea9fe', '100.64.0.1', '[::ffff:127.0.0.1]', '[fc00::1]', 'localhost', 'server.local']) {
    assert.equal(parseCallbackUrl(`https://${host}/hook`), null, host);
  }
  const resolve = answers => new Promise((resolve, reject) => {
    const connectLookup = publicLookup((_, options, done) => {
      assert.equal(options.all, true);
      done(null, answers);
    });
    connectLookup('merchant.test', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  });
  const publicAddresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700::1111', family: 6 }];
  assert.deepEqual(await resolve(publicAddresses), publicAddresses);
  await assert.rejects(resolve([...publicAddresses, { address: '169.254.169.254', family: 4 }]), { code: 'CALLBACK_ADDRESS_BLOCKED' });
});
