'use strict';
const crypto = require('node:crypto');

function constantEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const providerId = () => crypto.randomBytes(10).toString('hex');

function sanitizeAudit(value) {
  if (value === undefined || value === null) return null;
  const blocked = /authorization|digest|secret|password|api.?key|token|email|phone|msisdn|name|remarks|description|message|url|qr/i;
  const visit = (v, depth = 0) => {
    if (depth > 6) return '[depth limit]';
    if (typeof v === 'string') return v.slice(0, 512);
    if (Array.isArray(v)) return v.slice(0, 20).map(x => visit(x, depth + 1));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v).slice(0, 60)) {
        out[k] = blocked.test(k) ? '[redacted]' : visit(x, depth + 1);
      }
      return out;
    }
    return v;
  };
  const result = visit(value);
  if (JSON.stringify(result).length > 16000) return { truncated: true };
  return result;
}

module.exports = { constantEqual, sha256, providerId, sanitizeAudit };
