'use strict';
const fs = require('node:fs');

function loadConfig(env = process.env, { databaseOnly = false } = {}) {
  const text = (name, fallback = '') => String(env[name] ?? fallback).trim();
  const required = name => {
    const value = text(name);
    if (!value) throw new Error(`Set ${name} in .env.`);
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const raw = text(name, fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const bool = (name, fallback) => {
    const value = text(name, fallback).toLowerCase();
    if (!['true', 'false'].includes(value)) throw new Error(`${name} must be true or false.`);
    return value === 'true';
  };
  const nodeEnv = text('NODE_ENV', 'development');
  if (!['production', 'development', 'test'].includes(nodeEnv)) throw new Error('NODE_ENV is invalid.');
  const dbName = required('DB_NAME');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(dbName)) throw new Error('DB_NAME may contain only letters, numbers, and underscores.');
  const dbPassword = String(env.DB_PASSWORD ?? '');
  if (nodeEnv === 'production' && !dbPassword) throw new Error('Set DB_PASSWORD in .env.');
  const caFile = text('DB_SSL_CA_FILE');
  const config = {
    nodeEnv,
    db: {
      host: text('DB_HOST', '127.0.0.1'), port: integer('DB_PORT', 3306, 1, 65535),
      database: dbName, user: required('DB_USER'), password: dbPassword,
      connectionLimit: integer('DB_CONNECTION_LIMIT', 10, 1, 50),
      ...(caFile ? { ssl: { ca: fs.readFileSync(caFile), rejectUnauthorized: true } } : {})
    }
  };
  if (databaseOnly) return config;
  const httpsUrl = name => {
    let url;
    try { url = new URL(required(name)); } catch { throw new Error(`${name} must be a valid HTTPS URL.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error(`${name} must be HTTPS without credentials, query parameters, or fragments.`);
    }
    if (url.hostname.endsWith('.example') || url.hostname === 'example.com') throw new Error(`Replace the placeholder ${name}.`);
    return url.toString().replace(/\/$/, '');
  };
  const appApiKey = required('APP_API_KEY');
  if (appApiKey.length < 32) throw new Error('APP_API_KEY must contain at least 32 characters; run npm run setup.');
  const callbackOrigins = text('CALLBACK_ALLOWED_ORIGINS').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of callbackOrigins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('CALLBACK_ALLOWED_ORIGINS must contain HTTPS origins.'); }
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('CALLBACK_ALLOWED_ORIGINS must contain HTTPS origins without paths.');
  }
  const callbackSigningSecret = callbackOrigins.length ? required('CALLBACK_SIGNING_SECRET') : null;
  if (callbackSigningSecret && callbackSigningSecret.length < 32) throw new Error('CALLBACK_SIGNING_SECRET must contain at least 32 characters.');
  Object.assign(config, {
    host: text('HOST', '127.0.0.1'), port: integer('PORT', 3080, 1, 65535), appApiKey,
    trustProxyHops: integer('TRUST_PROXY_HOPS', 0, 0, 2),
    selcomBaseUrl: httpsUrl('SELCOM_BASE_URL'),
    selcomApiKey: required('SELCOM_API_KEY'), selcomApiSecret: required('SELCOM_API_SECRET'),
    selcomVendor: required('SELCOM_VENDOR'), publicWebhookUrl: httpsUrl('PUBLIC_WEBHOOK_URL'),
    callbackOrigins, callbackSigningSecret,
    selcomTimeoutMs: integer('SELCOM_TIMEOUT_MS', 20000, 1000, 60000),
    paymentMin: integer('PAYMENT_MIN_AMOUNT', 100, 1, 1000000000),
    paymentMax: integer('PAYMENT_MAX_AMOUNT', 10000000, 1, 1000000000),
    reconcileEnabled: bool('RECONCILE_ENABLED', 'true'),
    reconcilePollMs: integer('RECONCILE_POLL_MS', 15000, 1000, 60000),
    reconcileInitialDelayMs: integer('RECONCILE_INITIAL_DELAY_MS', 180000, 180000, 86400000),
    reconcileIntervalMs: integer('RECONCILE_INTERVAL_MS', 180000, 180000, 86400000),
    reconcileMaxAttempts: integer('RECONCILE_MAX_ATTEMPTS', 20, 1, 1000),
    reconcileBatchSize: integer('RECONCILE_BATCH_SIZE', 10, 1, 100),
    webhookMaxSkewSeconds: integer('WEBHOOK_MAX_SKEW_SECONDS', 300, 30, 86400),
    rateLimitWindowMs: integer('RATE_LIMIT_WINDOW_MS', 60000, 1000, 3600000),
    rateLimitMax: integer('RATE_LIMIT_MAX', 120, 1, 10000),
    webhookRateLimitMax: integer('WEBHOOK_RATE_LIMIT_MAX', 240, 1, 10000),
    jsonBodyLimit: text('JSON_BODY_LIMIT', '64kb')
  });
  if (config.paymentMin > config.paymentMax) throw new Error('PAYMENT_MIN_AMOUNT cannot exceed PAYMENT_MAX_AMOUNT.');
  if (!/^\d{1,3}kb$/i.test(config.jsonBodyLimit) || parseInt(config.jsonBodyLimit, 10) > 256) {
    throw new Error('JSON_BODY_LIMIT must be expressed in kb, at most 256kb.');
  }
  return config;
}

module.exports = { loadConfig };
