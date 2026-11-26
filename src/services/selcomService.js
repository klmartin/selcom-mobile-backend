'use strict';
const axios = require('axios');
const crypto = require('node:crypto');
const sdk = require('selcom-apigw-client');
const { constantEqual, sha256 } = require('../utils/security');

const CALLBACK_FIELDS = ['transid', 'order_id', 'reference', 'result', 'resultcode', 'payment_status'];

class SelcomService {
  constructor(config, { http = null, clock = () => Date.now() } = {}) {
    this.config = config;
    this.clock = clock;
    // The published 1.0.0 package exports apigwCLient, unlike its README.
    const Constructor = sdk.apigwCLient || sdk.apigwClient;
    if (typeof Constructor !== 'function') throw new Error('Unsupported selcom-apigw-client export.');
    const gatewayUrl = config.selcomBaseUrl.replace(/\/+$/, '');
    const baseURL = gatewayUrl.endsWith('/v1') ? gatewayUrl : `${gatewayUrl}/v1`;
    this.signer = new Constructor(baseURL, config.selcomApiKey, config.selcomApiSecret);
    this.http = http || axios.create({
      baseURL,
      timeout: config.selcomTimeoutMs,
      maxRedirects: 0, maxContentLength: 65536, maxBodyLength: 65536,
      validateStatus: () => true,
      responseType: 'text', transformResponse: [value => value]
    });
  }

  orderPayload(payment) {
    return {
      vendor: this.config.selcomVendor,
      order_id: payment.selcom_order_id,
      buyer_email: payment.customer_email,
      buyer_name: payment.customer_name,
      buyer_phone: payment.customer_phone,
      amount: Number(payment.amount),
      currency: payment.currency,
      webhook: Buffer.from(this.config.publicWebhookUrl, 'utf8').toString('base64'),
      buyer_remarks: payment.description || 'Payment',
      merchant_remarks: payment.merchant_reference,
      no_of_items: 1
    };
  }

  walletPayload(payment) {
    return { transid: payment.selcom_transid, order_id: payment.selcom_order_id, msisdn: payment.customer_phone };
  }

  async request(method, path, payload) {
    const [authorization, timestamp, digest, signedFields] = this.signer.computeHeader(payload);
    try {
      const response = await this.http.request({
        method, url: path,
        signal: AbortSignal.timeout(this.config.selcomTimeoutMs),
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json',
          Authorization: authorization, Timestamp: timestamp,
          'Digest-Method': 'HS256', Digest: digest, 'Signed-Fields': signedFields
        },
        ...(method === 'GET' ? { params: payload } : { data: payload })
      });
      let data = response.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { return { httpStatus: response.status, data: null, errorCode: 'INVALID_PROVIDER_JSON' }; }
      }
      if (!data || Array.isArray(data) || typeof data !== 'object') {
        return { httpStatus: response.status, data: null, errorCode: 'INVALID_PROVIDER_BODY' };
      }
      return { httpStatus: response.status, data, errorCode: null };
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PROVIDER_NETWORK_ERROR';
      return { httpStatus: null, data: null, errorCode: code };
    }
  }

  createCheckoutOrder(payment) { return this.request('POST', '/checkout/create-order-minimal', this.orderPayload(payment)); }
  initiateWalletPayment(payment) { return this.request('POST', '/checkout/wallet-payment', this.walletPayload(payment)); }
  getOrderStatus(payment) { return this.request('GET', '/checkout/order-status', { order_id: payment.selcom_order_id }); }

  verifyWebhook(headers, payload) {
    const fail = reason => ({ valid: false, reason, dedupeKey: sha256('invalid:' + JSON.stringify(payload ?? null)) });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('Invalid callback body.');
    if (!constantEqual(headers.authorization || '', 'SELCOM ' + Buffer.from(this.config.selcomApiKey, 'ascii').toString('base64'))) return fail('Invalid callback authorization.');
    if (headers['digest-method'] !== 'HS256') return fail('Unsupported callback signature algorithm.');
    const timestamp = headers.timestamp;
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp)) return fail('Invalid callback timestamp.');
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || Math.abs(this.clock() - time) > this.config.webhookMaxSkewSeconds * 1000) return fail('Callback timestamp outside permitted window.');
    const fieldHeader = headers['signed-fields'];
    if (typeof fieldHeader !== 'string' || fieldHeader.length > 1024) return fail('Missing signed callback fields.');
    const fields = fieldHeader.split(',');
    if (fields.some(f => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f) || f === 'timestamp') || new Set(fields).size !== fields.length) return fail('Invalid signed callback fields.');
    if (!CALLBACK_FIELDS.every(f => fields.includes(f))) return fail('Required callback fields are not signed.');
    if (fields.some(f => !Object.hasOwn(payload, f) || !['string', 'number', 'boolean'].includes(typeof payload[f]))) return fail('Invalid signed callback values.');
    if (CALLBACK_FIELDS.some(f => String(payload[f]).length < 1 || String(payload[f]).length > 128)) return fail('Invalid callback identifiers or status.');
    const signingString = 'timestamp=' + timestamp + fields.map(f => '&' + f + '=' + payload[f]).join('');
    const expected = crypto.createHmac('sha256', this.config.selcomApiSecret).update(signingString).digest('base64');
    if (!constantEqual(headers.digest || '', expected)) return fail('Invalid callback digest.');
    // Ignore timestamp and unsigned additions when identifying a repeated delivery.
    const canonical = CALLBACK_FIELDS.map(f => [f, String(payload[f])]);
    return { valid: true, reason: null, dedupeKey: sha256('valid:' + JSON.stringify(canonical)) };
  }
}

module.exports = { SelcomService, CALLBACK_FIELDS };
