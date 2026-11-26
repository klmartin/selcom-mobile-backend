'use strict';
const { randomUUID } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { sanitizeAudit } = require('../utils/security');

const ACTIVE = ['pending', 'awaiting_authorization', 'unresolved'];
const json = value => value == null ? null : JSON.stringify(sanitizeAudit(value));
const sqlDate = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ');

class PaymentRepository {
  constructor(pool, config, clock = () => Date.now()) {
    this.pool = pool;
    this.config = config;
    this.clock = clock;
  }

  async getById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM payments WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async getByPaymentId(id) {
    const [rows] = await this.pool.execute('SELECT * FROM payments WHERE payment_id = ?', [id]);
    return rows[0] || null;
  }

  async getByOrderId(id) {
    const [rows] = await this.pool.execute('SELECT * FROM payments WHERE selcom_order_id = ?', [id]);
    return rows[0] || null;
  }

  async createOrGet(record) {
    const keys = ['payment_id', 'merchant_reference', 'selcom_order_id', 'selcom_transid', 'idempotency_key', 'request_hash', 'customer_name', 'customer_email', 'customer_phone', 'amount', 'currency', 'description', 'callback_url'];
    try {
      const [result] = await this.pool.execute(
        `INSERT INTO payments (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
        keys.map(k => k === 'callback_url' ? record[k] ?? null : record[k])
      );
      return { payment: await this.getById(result.insertId), created: true };
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      const [sameKey] = await this.pool.execute('SELECT * FROM payments WHERE idempotency_key = ?', [record.idempotency_key]);
      if (sameKey[0]) {
        if (sameKey[0].request_hash !== record.request_hash) {
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for different payment details.');
        }
        return { payment: sameKey[0], created: false };
      }
      throw new AppError(409, 'REFERENCE_CONFLICT', 'This merchantReference is already registered. Retrieve its existing payment instead of creating another charge.');
    }
  }

  async claimDispatch(id, expectedStage, nextStage) {
    const [result] = await this.pool.execute(
      `UPDATE payments SET initiation_stage = ?, next_check_at = COALESCE(next_check_at, ?)
       WHERE id = ? AND initiation_stage = ? AND status IN ('pending','awaiting_authorization','unresolved')`,
      [nextStage, sqlDate(this.clock() + this.config.reconcileInitialDelayMs), id, expectedStage]
    );
    return result.affectedRows === 1;
  }

  async applyProgress(id, changes) {
    const permitted = ['status', 'initiation_stage', 'provider_reference', 'provider_result_code', 'provider_message'];
    const entries = Object.entries(changes).filter(([key]) => permitted.includes(key));
    if (!entries.length) return;
    const terminal = ['failed', 'cancelled'].includes(changes.status);
    await this.pool.execute(
      `UPDATE payments SET ${entries.map(([key]) => `${key} = ?`).join(', ')},
        next_check_at = ${terminal ? 'NULL' : 'COALESCE(next_check_at, ?)'}
       WHERE id = ? AND status IN ('pending','awaiting_authorization','unresolved')`,
      [...entries.map(([, value]) => value), ...(terminal ? [] : [sqlDate(this.clock() + this.config.reconcileIntervalMs)]), id]
    );
  }

  async startAttempt(paymentId, operation, request) {
    const [result] = await this.pool.execute(
      'INSERT INTO payment_attempts (payment_id, operation, request_payload) VALUES (?,?,?)',
      [paymentId, operation, json(request)]
    );
    return result.insertId;
  }

  async finishAttempt(id, result, duration) {
    await this.pool.execute(
      'UPDATE payment_attempts SET response_payload=?, http_status=?, transport_error_code=?, duration_ms=?, finished_at=? WHERE id=?',
      [json(result.data), result.httpStatus || null, result.errorCode || null, Math.max(0, Math.round(duration)), sqlDate(this.clock()), id]
    );
  }

  async list({ page, pageSize, status }) {
    const condition = status ? ' WHERE status = ?' : '';
    const values = status ? [status] : [];
    const [counts] = await this.pool.execute('SELECT COUNT(*) AS total FROM payments' + condition, values);
    // Bounds are validated integers before interpolation; mysql2 has LIMIT binding differences across servers.
    const [rows] = await this.pool.execute(
      `SELECT * FROM payments${condition} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values
    );
    return { rows, total: Number(counts[0].total) };
  }

  async claimCheck({ id = null, allowEarly = false, manual = false } = {}) {
    const connection = await this.pool.getConnection();
    const token = randomUUID();
    const now = sqlDate(this.clock());
    try {
      await connection.beginTransaction();
      const conditions = ["status <> 'succeeded'", "initiation_stage <> 'recorded'", '(reconcile_until IS NULL OR reconcile_until <= ?)'];
      const values = [now];
      if (id !== null) { conditions.push('id = ?'); values.push(id); }
      if (!manual) {
        conditions.push("status IN ('pending','awaiting_authorization','unresolved')", 'reconciliation_attempts < ?');
        values.push(this.config.reconcileMaxAttempts);
      }
      if (!allowEarly) {
        conditions.push(manual ? '(next_check_at <= ? OR (next_check_at IS NULL AND (last_checked_at IS NULL OR last_checked_at <= ?)))' : 'next_check_at <= ?');
        values.push(now);
        if (manual) values.push(sqlDate(this.clock() - this.config.reconcileIntervalMs));
      }
      const [rows] = await connection.execute(
        `SELECT * FROM payments WHERE ${conditions.join(' AND ')} ORDER BY next_check_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, values
      );
      if (!rows[0]) { await connection.commit(); return null; }
      const row = rows[0];
      const until = sqlDate(this.clock() + this.config.selcomTimeoutMs + 30000);
      await connection.execute(
        'UPDATE payments SET reconcile_token=?, reconcile_until=?, last_checked_at=?, reconciliation_attempts=reconciliation_attempts+1, manual_review=?, next_check_at=CASE WHEN ? THEN NULL ELSE next_check_at END WHERE id=?',
        [token, until, now, Number(row.reconciliation_attempts) + 1 >= this.config.reconcileMaxAttempts ? 1 : 0,
          Number(row.reconciliation_attempts) + 1 >= this.config.reconcileMaxAttempts ? 1 : 0, row.id]
      );
      await connection.commit();
      return { ...row, reconcile_token: token, reconciliation_attempts: Number(row.reconciliation_attempts) + 1 };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async completeCheck(payment, outcome) {
    const terminal = ['succeeded', 'failed', 'cancelled'].includes(outcome.status);
    const review = !terminal && payment.reconciliation_attempts >= this.config.reconcileMaxAttempts;
    const next = terminal || review ? null : sqlDate(this.clock() + this.config.reconcileIntervalMs);
    await this.pool.execute(
      `UPDATE payments SET status=?, provider_payment_status=?, provider_reference=COALESCE(?,provider_reference),
       provider_result_code=?, provider_message=?, manual_review=?, next_check_at=?,
       paid_at=CASE WHEN ? = 'succeeded' THEN COALESCE(paid_at,?) ELSE paid_at END,
       reconcile_token=NULL, reconcile_until=NULL
       WHERE id=? AND reconcile_token=? AND status <> 'succeeded'`,
      [outcome.status, outcome.providerStatus || null, outcome.reference || null,
        outcome.code || null, outcome.message, review ? 1 : 0, next,
        outcome.status, sqlDate(this.clock()), payment.id, payment.reconcile_token]
    );
    // A concurrent confirmed success remains immutable, but the claim can be released.
    await this.pool.execute('UPDATE payments SET reconcile_token=NULL, reconcile_until=NULL WHERE id=? AND reconcile_token=?', [payment.id, payment.reconcile_token]);
    await this.pool.execute(
      "UPDATE webhook_events SET processing_status='verified', processed_at=? WHERE payment_id=? AND verification_status='valid' AND processing_status='queued' AND EXISTS (SELECT 1 FROM payments WHERE id=? AND status='succeeded')",
      [sqlDate(this.clock()), payment.id, payment.id]
    );
  }

  async storeWebhook({ paymentId = null, key, payload, verified, error = null, forward = false }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Lock the parent first to avoid FK shared-lock upgrades racing other callbacks.
      if (paymentId !== null) await connection.execute('SELECT id FROM payments WHERE id=? FOR UPDATE', [paymentId]);
      const [result] = await connection.execute(
        `INSERT INTO webhook_events (payment_id,dedupe_key,payload,verification_status,processing_status,error_message,delivery_due_at)
         VALUES (?,?,?,?,?,?,?)`,
        [paymentId, key, JSON.stringify(payload ?? null), verified ? 'valid' : 'invalid', verified ? 'queued' : 'rejected', error,
          verified && forward ? sqlDate(this.clock()) : null]
      );
      if (verified && paymentId !== null) {
        await connection.execute(
          `UPDATE payments SET next_check_at=?, manual_review=FALSE,
           status=CASE WHEN status IN ('failed','cancelled') THEN 'unresolved' ELSE status END,
           reconciliation_attempts=LEAST(reconciliation_attempts,?) WHERE id=? AND status <> 'succeeded'`,
          [sqlDate(this.clock()), this.config.reconcileMaxAttempts - 1, paymentId]
        );
        await connection.execute(
          `UPDATE webhook_events SET processing_status='verified', processed_at=?
           WHERE id=? AND EXISTS (SELECT 1 FROM payments WHERE id=? AND status='succeeded')`,
          [sqlDate(this.clock()), result.insertId, paymentId]
        );
      }
      await connection.commit();
      return { id: result.insertId, created: true };
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') return { id: null, created: false };
      throw error;
    } finally { connection.release(); }
  }

  async claimDelivery(maxAttempts) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, payment_id, dedupe_key, payload, delivery_attempts FROM webhook_events
         WHERE delivery_due_at <= ? AND delivery_attempts < ? ORDER BY delivery_due_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [sqlDate(this.clock()), maxAttempts]
      );
      const event = rows[0];
      if (event) {
        event.delivery_token = randomUUID();
        event.delivery_attempts++;
        await connection.execute(
          'UPDATE webhook_events SET delivery_attempts=?, delivery_token=?, delivery_due_at=?, delivery_http_status=NULL WHERE id=?',
          [event.delivery_attempts, event.delivery_token, sqlDate(this.clock() + 30000), event.id]
        );
      }
      await connection.commit();
      return event || null;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async completeDelivery(event, { status, delivered, retryDelay }) {
    const now = this.clock();
    await this.pool.execute(
      `UPDATE webhook_events SET delivery_token=NULL, delivery_due_at=?, delivery_http_status=?, delivered_at=?
       WHERE id=? AND delivery_token=?`,
      [retryDelay ? sqlDate(now + retryDelay) : null, status, delivered ? sqlDate(now) : null, event.id, event.delivery_token]
    );
  }
}

module.exports = { PaymentRepository, ACTIVE, sqlDate };
