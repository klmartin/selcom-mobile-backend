module.exports = {
  apps: [{
    name: 'selcom-payments', script: 'src/server.js', cwd: __dirname,
    instances: 1, exec_mode: 'fork', autorestart: true,
    kill_timeout: 65000, max_memory_restart: '300M',
    env: { NODE_ENV: 'production' }
  }]
};
