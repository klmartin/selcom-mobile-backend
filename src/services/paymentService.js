'use strict';
const { randomUUID } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { providerId, sha256 } = require('../utils/security');
const { parsePayment, parseIdempotencyKey, amountCents } = require('../utils/validation');

const inProgress = code => ['111', '927', '999'].includes(code);
const text = (value, max = 128) => value === undefined || value === null ? null : String(value).slice(0, max);
const ok = reply => reply && !reply.errorCode && reply.httpStatus >= 200 && reply.httpStatus < 300;

function isoDate(value) {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z')).toISOString();
}

function publicPayment(row) {
  return {
    paymentId: row.payment_id, merchantReference: row.merchant_reference,
    amount: String(row.amount), currency: row.currency, phone: row.customer_phone,
    status: row.status, initiationStage: row.initiation_stage,
    providerStatus: row.provider_payment_status, providerReference: row.provider_reference,
    message: row.provider_message || 'Payment recorded.', manualReview: Boolean(row.manual_review),
    createdAt: isoDate(row.created_at), updatedAt: isoDate(row.updated_at),
    paidAt: isoDate(row.paid_at), lastCheckedAt: isoDate(row.last_checked_at), nextCheckAt: isoDate(row.next_check_at)
  };
}

function queryOutcome(reply, payment) {
  const uncertain = (message, extra = {}) => ({ status: 'unresolved', message, ...extra });
  const body = reply?.data;
  const code = text(body?.resultcode, 32);
  if (!ok(reply)) return uncertain('Provider status could not be confirmed.', { code });
  if (inProgress(code)) return uncertain('Provider processing is still unresolved.', { code });
  if (body?.result !== 'SUCCESS' || code !== '000' || !Array.isArray(body.data) || body.data.length !== 1) {
    return uncertain('Provider returned an unconfirmed status response.', { code });
  }
  const data = body.data[0];
  if (!data || typeof data !== 'object' || String(data.order_id) !== payment.selcom_order_id) return uncertain('Provider order identity did not match.', { code });
  if (amountCents(data.amount) === null || amountCents(data.amount) !== amountCents(payment.amount) || (data.currency !== undefined && data.currency !== payment.currency)) {
    return uncertain('Provider amount or currency did not match; review required.', { code });
  }
  const providerStatus = text(data.payment_status, 32);
  const reference = text(data.reference || body.reference);
  if (providerStatus === 'COMPLETED') return { status: 'succeeded', providerStatus, reference, code, message: 'Payment confirmed by Selcom.' };
  if (['CANCELLED', 'USERCANCELLED', 'USERCANCELED'].includes(providerStatus)) return { status: 'cancelled', providerStatus, reference, code, message: 'Payment cancelled.' };
  if (providerStatus === 'REJECTED') return { status: 'failed', providerStatus, reference, code, message: 'Payment rejected by provider.' };
  if (['PENDING', 'INPROGRESS'].includes(providerStatus)) return { status: 'awaiting_authorization', providerStatus, reference, code, message: 'Awaiting customer authorization or provider confirmation.' };
  return uncertain('Provider payment status requires review.', { code, providerStatus, reference });
}

class PaymentService {
  constructor(repository, selcom, config, clock = () => Date.now()) {
    this.repo = repository; this.selcom = selcom; this.config = config; this.clock = clock;
  }

  async getPayment(id) {
    const row = await this.repo.getByPaymentId(id);
    if (!row) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
    return row;
  }

  async invoke(payment, operation, payload, fn) {
    const attemptId = await this.repo.startAttempt(payment.id, operation, payload);
    const start = this.clock();
    let reply;
    try { reply = await fn(); }
    catch { reply = { httpStatus: null, data: null, errorCode: 'PROVIDER_ADAPTER_ERROR' }; }
    await this.repo.finishAttempt(attemptId, reply, this.clock() - start);
    return reply;
  }

  async initiate(input, idempotencyHeader) {
    const normalized = parsePayment(input, this.config);
    const key = parseIdempotencyKey(idempotencyHeader);
    const record = {
      payment_id: randomUUID(), merchant_reference: normalized.merchantReference,
      selcom_order_id: providerId(), selcom_transid: providerId(), idempotency_key: key,
      request_hash: sha256(JSON.stringify(normalized)), customer_name: normalized.customerName,
      customer_email: normalized.customerEmail, customer_phone: normalized.phone,
      amount: normalized.amount.toFixed(2), currency: normalized.currency, description: normalized.description
    };
    const result = await this.repo.createOrGet(record);
    let payment = result.payment;
    if (payment.initiation_stage === 'recorded' && await this.repo.claimDispatch(payment.id, 'recorded', 'order_dispatching')) {
      const reply = await this.invoke(payment, 'create_order', this.selcom.orderPayload(payment), () => this.selcom.createCheckoutOrder(payment));
      const code = text(reply.data?.resultcode, 32);
      const success = ok(reply) && reply.data?.result === 'SUCCESS' && code === '000' && Array.isArray(reply.data.data) && reply.data.data.length > 0;
      const definitiveFailure = ok(reply) && reply.data?.result === 'FAIL' && code && !inProgress(code) && code !== '000';
      await this.repo.applyProgress(payment.id, {
        initiation_stage: success ? 'order_created' : 'order_uncertain',
        status: success ? 'pending' : definitiveFailure ? 'failed' : 'unresolved',
        provider_result_code: code, provider_reference: text(reply.data?.reference),
        provider_message: success ? 'Order created; preparing mobile authorization.' : definitiveFailure ? 'Provider rejected order creation.' : 'Order creation outcome is uncertain; checking status before any further action.'
      });
    }
    payment = await this.repo.getById(payment.id);
    if (payment.initiation_stage === 'order_created' && await this.repo.claimDispatch(payment.id, 'order_created', 'prompt_dispatching')) {
      // No resend is possible after this claim, including across process restarts.
      payment = await this.repo.getById(payment.id);
      if (payment.status !== 'succeeded') {
        const reply = await this.invoke(payment, 'wallet_payment', this.selcom.walletPayload(payment), () => this.selcom.initiateWalletPayment(payment));
        const code = text(reply.data?.resultcode, 32);
        const accepted = ok(reply) && ((code === '000' && reply.data?.result === 'SUCCESS') || (['111', '927'].includes(code) && ['PENDING', 'INPROGRESS'].includes(reply.data?.result)));
        const definitiveFailure = ok(reply) && reply.data?.result === 'FAIL' && code && code !== '000' && !inProgress(code);
        await this.repo.applyProgress(payment.id, {
          initiation_stage: accepted ? 'prompt_accepted' : 'prompt_uncertain',
          status: accepted ? 'awaiting_authorization' : definitiveFailure ? 'failed' : 'unresolved',
          provider_result_code: code, provider_reference: text(reply.data?.reference),
          provider_message: accepted ? 'Authorize the payment on your phone. Awaiting confirmation.' : definitiveFailure ? 'Provider rejected the mobile payment request.' : 'Payment request outcome is uncertain; do not repeat the charge.'
        });
      }
    }
    return { payment: await this.repo.getById(payment.id), replayed: !result.created };
  }

  async checkClaim(payment) {
    const reply = await this.invoke(payment, 'status_query', { order_id: payment.selcom_order_id }, () => this.selcom.getOrderStatus(payment));
    await this.repo.completeCheck(payment, queryOutcome(reply, payment));
    return this.repo.getById(payment.id);
  }

  async refresh(id) {
    const payment = await this.getPayment(id);
    const claim = await this.repo.claimCheck({ id: payment.id, manual: true });
    return claim ? this.checkClaim(claim) : this.repo.getById(payment.id);
  }

  async reconcileBatch({ shouldStop = () => false } = {}) {
    let checked = 0;
    for (; checked < this.config.reconcileBatchSize; checked++) {
      if (shouldStop()) break;
      const payment = await this.repo.claimCheck();
      if (!payment) break;
      await this.checkClaim(payment);
    }
    return checked;
  }

  async handleWebhook(headers, payload) {
    const verification = this.selcom.verifyWebhook(headers, payload);
    if (!verification.valid) {
      await this.repo.storeWebhook({ key: verification.dedupeKey, payload, verified: false, error: verification.reason });
      throw new AppError(401, 'INVALID_CALLBACK', verification.reason);
    }
    const payment = await this.repo.getByOrderId(String(payload.order_id));
    if (!payment || String(payload.transid) !== payment.selcom_transid) {
      await this.repo.storeWebhook({ key: verification.dedupeKey, payload, verified: false, error: 'Unknown order or merchant transaction ID.' });
      throw new AppError(400, 'CALLBACK_PAYMENT_MISMATCH', 'Callback did not match a registered payment.');
    }
    // The repository stores the event AND schedules a status check in one transaction.
    // Never trust unsigned amount/phone/channel fields, or mark paid from a callback alone.
    await this.repo.storeWebhook({ paymentId: payment.id, key: verification.dedupeKey, payload, verified: true });
    return { result: 'SUCCESS', resultcode: '000', message: 'Accepted' };
  }
}

module.exports = { PaymentService, publicPayment, queryOutcome };
