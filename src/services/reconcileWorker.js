'use strict';

function startWorker(run, interval, errorEvent, logger = console) {
  let running = false;
  let stopped = false;
  let inFlight = Promise.resolve();
  const tick = () => {
    if (running || stopped) return;
    running = true;
    inFlight = run({ shouldStop: () => stopped })
      .catch(error => logger.error(JSON.stringify({ event: errorEvent, code: error.code || 'WORKER_ERROR' })))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await inFlight; } };
}

module.exports = { startWorker };
