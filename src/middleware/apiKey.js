'use strict';
const { constantEqual } = require('../utils/security');
const { AppError } = require('../utils/errors');

function apiKey(config) {
  return (req, res, next) => {
    if (!constantEqual(req.get('X-API-Key') || '', config.appApiKey)) return next(new AppError(401, 'UNAUTHORIZED', 'A valid X-API-Key header is required.'));
    next();
  };
}

module.exports = { apiKey };
