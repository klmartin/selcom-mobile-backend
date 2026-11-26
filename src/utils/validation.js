'use strict';
const { z } = require('zod');
const { AppError } = require('./errors');
const { parseCallbackUrl } = require('./callbackUrl');

function normalizePhone(value) {
  let phone = String(value).trim().replace(/[ ()-]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (/^0[67]\d{8}$/.test(phone)) phone = '255' + phone.slice(1);
  if (!/^255[67]\d{8}$/.test(phone)) {
    throw new AppError(400, 'INVALID_PHONE', 'Use a Tanzanian mobile number such as 07XXXXXXXX or 2557XXXXXXXX.');
  }
  return phone;
}

function parsePayment(input, config) {
  const schema = z.object({
    merchantReference: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
    phone: z.string().min(1).max(32),
    amount: z.number().int().safe().min(config.paymentMin).max(config.paymentMax),
    currency: z.literal('TZS').default('TZS'),
    customerName: z.string().trim().min(1).max(150).regex(/^[^\x00-\x1f]+$/),
    customerEmail: z.string().trim().email().max(254),
    description: z.string().trim().max(250).regex(/^[^\x00-\x1f]*$/).default(''),
    callbackUrl: z.string().trim().max(2048).optional()
  }).strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(x => x.path.join('.') || 'body'))];
    throw new AppError(400, 'INVALID_REQUEST', `Check the following fields: ${fields.join(', ')}.`);
  }
  const payment = { ...parsed.data, phone: normalizePhone(parsed.data.phone) };
  if (payment.callbackUrl !== undefined) {
    const url = parseCallbackUrl(payment.callbackUrl);
    if (!url) throw new AppError(400, 'INVALID_CALLBACK_URL', 'Use a public HTTPS callback URL without credentials or a fragment.');
    payment.callbackUrl = url.href;
  }
  return payment;
}

function parseIdempotencyKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header containing 1–128 letters, numbers, dots, underscores, colons, or hyphens.');
  }
  return value;
}

function validUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, 'INVALID_PAYMENT_ID', 'paymentId must be a UUID returned by this API.');
  }
  return value;
}

function amountCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

module.exports = { normalizePhone, parsePayment, parseIdempotencyKey, validUuid, amountCents };
