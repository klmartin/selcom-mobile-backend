'use strict';
const mysql = require('mysql2/promise');

function createPool(config) {
  const pool = mysql.createPool({
    ...config.db, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true,
    decimalNumbers: false, multipleStatements: false,
    waitForConnections: true, queueLimit: 100, enableKeepAlive: true,
    connectTimeout: 10000
  });
  pool.pool.on('connection', connection => {
    connection.query("SET time_zone = '+00:00'", error => { if (error) connection.destroy(); });
  });
  return pool;
}

module.exports = { createPool };
