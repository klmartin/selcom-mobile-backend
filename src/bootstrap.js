'use strict';
const { createPool } = require('./db/pool');
const { PaymentRepository } = require('./repositories/paymentRepository');
const { SelcomService } = require('./services/selcomService');
const { PaymentService } = require('./services/paymentService');

function bootstrap(config) {
  const pool = createPool(config);
  const repository = new PaymentRepository(pool, config);
  const selcom = new SelcomService(config);
  const service = new PaymentService(repository, selcom, config);
  return { pool, service };
}

module.exports = { bootstrap };
