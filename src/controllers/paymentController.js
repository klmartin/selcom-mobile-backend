'use strict';
const { publicPayment } = require('../services/paymentService');
const { validUuid } = require('../utils/validation');
const { AppError } = require('../utils/errors');
const { ACTIVE } = require('../repositories/paymentRepository');

function paymentController(service) {
  return {
    create: async (req, res) => {
      const { payment, replayed } = await service.initiate(req.body, req.get('Idempotency-Key'));
      req.paymentId = payment.payment_id;
      res.status(ACTIVE.includes(payment.status) ? 202 : 200).json({ data: publicPayment(payment), replayed });
    },
    get: async (req, res) => {
      const payment = await service.getPayment(validUuid(req.params.paymentId));
      req.paymentId = payment.payment_id;
      res.json({ data: publicPayment(payment) });
    },
    list: async (req, res) => {
      const { page = '1', pageSize = '20', status } = req.query;
      if (!/^\d{1,6}$/.test(String(page)) || !/^\d{1,3}$/.test(String(pageSize)) || Number(page) < 1 || Number(pageSize) < 1 || Number(pageSize) > 100) {
        throw new AppError(400, 'INVALID_PAGINATION', 'Use page >= 1 and pageSize between 1 and 100.');
      }
      if (status !== undefined && ![...ACTIVE, 'succeeded', 'failed', 'cancelled'].includes(status)) throw new AppError(400, 'INVALID_STATUS', 'Unsupported payment status filter.');
      const result = await service.repo.list({ page: Number(page), pageSize: Number(pageSize), status });
      res.json({ data: result.rows.map(publicPayment), pagination: { page: Number(page), pageSize: Number(pageSize), total: result.total } });
    },
    refresh: async (req, res) => {
      const payment = await service.refresh(validUuid(req.params.paymentId));
      req.paymentId = payment.payment_id;
      res.json({ data: publicPayment(payment) });
    },
    webhook: async (req, res) => res.json(await service.handleWebhook(req.headers, req.body))
  };
}

module.exports = { paymentController };
