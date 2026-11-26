'use strict';

function startWorker(service, config, logger = console) {
  let running = false;
  let stopped = false;
  let inFlight = Promise.resolve();
  const tick = () => {
    if (running || stopped) return;
    running = true;
    inFlight = service.reconcileBatch({ shouldStop: () => stopped })
      .catch(error => logger.error(JSON.stringify({ event: 'reconciliation_error', code: error.code || 'RECONCILE_ERROR' })))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, config.reconcilePollMs);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await inFlight; } };
}

module.exports = { startWorker };
