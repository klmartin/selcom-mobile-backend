'use strict';
const { Router } = require('express');

function paymentRoutes(controller) {
  const router = Router();
  router.post('/mobile', controller.create);
  router.get('/', controller.list);
  router.get('/:paymentId', controller.get);
  router.post('/:paymentId/refresh', controller.refresh);
  return router;
}

module.exports = { paymentRoutes };
