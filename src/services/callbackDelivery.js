'use strict';
const axios = require('axios');
const { Agent } = require('node:https');
const { CALLBACK_FIELDS } = require('./selcomService');
const { parseCallbackUrl, publicLookup } = require('../utils/callbackUrl');

const MAX_ATTEMPTS = 5;
const httpsAgent = new Agent({ lookup: publicLookup() });

async function deliverCallback(repository, http = axios) {
  const event = await repository.claimDelivery(MAX_ATTEMPTS);
  if (!event) return;

  const payment = await repository.getById(event.payment_id);
  const url = parseCallbackUrl(payment?.callback_url);
  let status = null;
  let retryable = Boolean(url);
  if (url) {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    const body = JSON.stringify({
      eventId: event.dedupe_key,
      event: 'selcom.callback',
      paymentId: payment.payment_id,
      merchantReference: payment.merchant_reference,
      callback: Object.fromEntries(CALLBACK_FIELDS.map(field => [field, payload[field]]))
    });
    try {
      const reply = await http.post(url.href, body, {
        headers: { 'Content-Type': 'application/json' }, httpsAgent,
        signal: AbortSignal.timeout(5000), maxRedirects: 0, maxContentLength: 16384,
        proxy: false, validateStatus: () => true
      });
      status = reply.status;
    } catch (error) {
      status = error.response?.status ?? null;
      retryable = error.code !== 'CALLBACK_ADDRESS_BLOCKED';
    }
  }

  const delivered = status >= 200 && status < 300;
  const retryDelay = retryable && !delivered && event.delivery_attempts < MAX_ATTEMPTS ? 15000 * 2 ** (event.delivery_attempts - 1) : null;
  await repository.completeDelivery(event, { status, delivered, retryDelay });
}

module.exports = { deliverCallback };
