'use strict';
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const { apiKey } = require('./middleware/apiKey');
const { paymentController } = require('./controllers/paymentController');
const { paymentRoutes } = require('./routes/payments');
const { AppError } = require('./utils/errors');

function createApp({ service, config, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops || false);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    const start = Date.now();
    res.on('finish', () => logger.info(JSON.stringify({
      event: 'http_request', requestId: req.requestId, method: req.method,
      route: req.route?.path || 'unmatched', status: res.statusCode,
      durationMs: Date.now() - start, ...(req.paymentId ? { paymentId: req.paymentId } : {})
    })));
    next();
  });
  const limiter = max => rateLimit({
    windowMs: config.rateLimitWindowMs, limit: max,
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests; retry later.' } }
  });
  const json = express.json({ limit: config.jsonBodyLimit, strict: true, type: 'application/json' });
  const requireJson = (req, res, next) => {
    if (!req.is('application/json')) return next(new AppError(415, 'JSON_REQUIRED', 'Send Content-Type: application/json.'));
    next();
  };
  const controller = paymentController(service);
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/v1/webhooks/selcom', limiter(config.webhookRateLimitMax), requireJson, json, controller.webhook);
  app.use('/api/v1/payments', limiter(config.rateLimitMax), apiKey(config), json, paymentRoutes(controller));
  app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error instanceof AppError ? error.status : 500;
    let code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    let message = error instanceof AppError ? error.message : 'The request could not be completed. Retrieve the existing payment before retrying.';
    if (error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Invalid JSON request body.'; }
    if (error.type === 'entity.too.large') { status = 413; code = 'BODY_TOO_LARGE'; message = 'Request body is too large.'; }
    if (status >= 500) logger.error(JSON.stringify({ event: 'request_error', requestId: req.requestId, code: error.code || 'INTERNAL_ERROR' }));
    res.status(status).json({ error: { code, message }, requestId: req.requestId });
  });
  return app;
}

module.exports = { createApp };
