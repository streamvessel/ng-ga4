// Driven by run.js through Playwright. Never a caller itself, so it never
// takes part in a race.
const bc = new BroadcastChannel('probe');
const waiters = new Set();
bc.onmessage = (e) => { for (const w of [...waiters]) w(e.data); };

function waitFor(pred, ms = 10000) {
  return new Promise((resolve, reject) => {
    const w = (d) => { if (pred(d)) { clearTimeout(t); waiters.delete(w); resolve(d); } };
    const t = setTimeout(() => { waiters.delete(w); reject(new Error('timed out waiting')); }, ms);
    waiters.add(w);
  });
}

self.pingAll = async (contexts) => {
  const seen = new Set();
  const all = new Promise((resolve) => {
    const w = (d) => { if (d.cmd === 'pong') { seen.add(d.ctx); if (contexts.every((c) => seen.has(c))) { waiters.delete(w); resolve(); } } };
    waiters.add(w);
  });
  bc.postMessage({ cmd: 'ping' });
  await all;
  return [...seen];
};

// holder takes the lock; asker asks for it with ifAvailable from its own context.
self.crossTry = async (holder, asker) => {
  bc.postMessage({ cmd: 'hold', ctx: holder });
  await waitFor((d) => d.cmd === 'holding' && d.ctx === holder);
  bc.postMessage({ cmd: 'try', ctx: asker });
  const result = await waitFor((d) => d.cmd === 'tried' && d.ctx === asker);
  bc.postMessage({ cmd: 'release' });
  await new Promise((r) => setTimeout(r, 50));
  return result;
};

// One race: empty storage, then every caller starts at once.
self.race = async (run, useLocks, callers) => {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  const expected = Object.keys(callers).length;
  const results = [];
  const done = new Promise((resolve) => {
    const w = (d) => {
      if (d.cmd === 'result' && d.run === run) {
        results.push(d);
        if (results.length === expected) { waiters.delete(w); resolve(); }
      }
    };
    waiters.add(w);
  });
  bc.postMessage({ cmd: 'go', run, useLocks, callers });
  await done;
  const stored = (await chrome.storage.local.get('ga_client_id')).ga_client_id;
  return { results, stored };
};
