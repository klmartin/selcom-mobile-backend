'use strict';
const axios = require('axios');
const { createHmac } = require('node:crypto');
const { CALLBACK_FIELDS } = require('./selcomService');

const MAX_ATTEMPTS = 5;

async function deliverCallback(repository, config, http = axios) {
  const event = await repository.claimDelivery(MAX_ATTEMPTS);
  if (!event) return;

  const payment = await repository.getById(event.payment_id);
  const url = payment?.callback_url ? new URL(payment.callback_url) : null;
  let status = null;
  const allowed = url?.protocol === 'https:' && !url.username && !url.password && config.callbackOrigins.includes(url.origin);
  if (allowed) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    const body = JSON.stringify({
      eventId: event.dedupe_key,
      event: 'selcom.callback',
      paymentId: payment.payment_id,
      merchantReference: payment.merchant_reference,
      callback: Object.fromEntries(CALLBACK_FIELDS.map(field => [field, payload[field]]))
    });
    const signature = createHmac('sha256', config.callbackSigningSecret).update(body).digest('hex');
    try {
      const reply = await http.post(url.href, body, {
        headers: { 'Content-Type': 'application/json', 'X-Callback-Signature': `sha256=${signature}` },
        signal: AbortSignal.timeout(5000), maxRedirects: 0, maxContentLength: 16384,
        proxy: false, validateStatus: () => true
      });
      status = reply.status;
    } catch (error) { status = error.response?.status ?? null; }
  }

  const delivered = status >= 200 && status < 300;
  const retryDelay = allowed && !delivered && event.delivery_attempts < MAX_ATTEMPTS ? 15000 * 2 ** (event.delivery_attempts - 1) : null;
  await repository.completeDelivery(event, { status, delivered, retryDelay });
}

module.exports = { deliverCallback };
