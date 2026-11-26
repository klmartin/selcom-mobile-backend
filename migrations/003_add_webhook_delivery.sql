ALTER TABLE webhook_events
  ADD COLUMN delivery_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN delivery_due_at DATETIME(6) NULL,
  ADD COLUMN delivery_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN delivery_http_status SMALLINT UNSIGNED NULL,
  ADD COLUMN delivered_at DATETIME(6) NULL,
  ADD KEY idx_webhook_delivery (delivery_due_at, id);
